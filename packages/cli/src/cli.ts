import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { FSWatcher } from "node:fs";
import { readFileSync, realpathSync, statSync, watch } from "node:fs";
import type { Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import { parseArgs } from "node:util";
import type * as Schmock from "@schmock/core";
import {
  collectBody,
  HTTP_METHODS,
  HttpIngressError,
  isHttpMethod,
  normalizeResponse,
  parseNodeHeaders,
  parseNodeQuery,
  ResourceLimitError,
  schmock,
  writeRejectedSchmockResponse,
  writeSchmockResponse,
} from "@schmock/core";
import { MAX_SEED_MANIFEST_BYTES, openapi } from "@schmock/openapi";

export interface CliOptions {
  spec: string;
  port?: number;
  hostname?: string;
  seed?: string;
  cors?: boolean;
  debug?: boolean;
  fakerSeed?: number;
  errors?: boolean;
  watch?: boolean;
  admin?: boolean;
  /**
   * Bearer token required by every `/schmock-admin/*` request (`--admin-token`).
   * When `admin` is on and this is omitted, a random token is minted once and
   * surfaced on {@link CliServer.adminToken}.
   */
  adminToken?: string;
  /**
   * How many requests the mock retains for `GET /schmock-admin/history`
   * (`--admin-history-limit`, default 500). Ignored — history is disabled
   * entirely — when `admin` is off.
   */
  adminHistoryLimit?: number;
  /** Validate the spec against the OpenAPI schema at startup (`--strict`). */
  strict?: boolean;
  /** Resolve `$ref`s outside the spec document (`--refs-external`). */
  refsExternal?: boolean;
  /**
   * Hosts an `http(s)` `$ref` may target (`--refs-allow-http`). Supplying this
   * also enables http resolution, which still requires `refsExternal`.
   */
  refsAllowHttp?: string[];
  /**
   * How long {@link CliServer.close} waits for in-flight requests before the
   * remaining sockets are destroyed (default 5000 ms). A half-sent request
   * never completes on its own, so without a bound the close would hang.
   */
  shutdownGraceMs?: number;
}

export interface CliServer {
  server: Server;
  port: number;
  hostname: string;
  /**
   * The bearer token this server requires on `/schmock-admin/*`. Present only
   * when admin is enabled; supply it as `Authorization: Bearer <token>`.
   */
  adminToken?: string;
  /**
   * Stop watching, stop accepting, and settle once the socket is released —
   * within {@link CliOptions.shutdownGraceMs}. Memoized: every call observes
   * the same shutdown, so closing twice is safe and resolves twice.
   */
  close(): Promise<void>;
}

const MAX_REQUEST_BODY_SIZE = 10 * 1024 * 1024;
/** Default ceiling on how long a graceful close waits for in-flight requests. */
const SHUTDOWN_GRACE_MS = 5_000;
const ALLOWED_METHODS = HTTP_METHODS.join(", ");
const ADMIN_PATH_PREFIX = "/schmock-admin/";
const DEFAULT_ADMIN_HISTORY_LIMIT = 500;
const REDACTED = "[redacted]";
/**
 * Header names whose values the admin history projection masks. Redaction is
 * deliberately confined to this projection: `mock.history()` is public core API
 * and library users legitimately assert on the raw values. A recorded request
 * carries request headers only, so `set-cookie` matters only when a client
 * sends it; it stays listed so the set never shrinks.
 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-schmock-admin-token",
]);
/**
 * A header or query parameter named like a credential: exactly `key`, `token`,
 * `apikey`, `api_key`, `api-key`, `secret` or `password`, or any name ending in
 * one of those after a `-` or `_` (`X-Pet-Key`, `access_token`,
 * `client_secret`). The openapi plugin does not expose the apiKey scheme names
 * a spec declares, so this catches the conventional spellings of them; a name
 * outside the pattern (`X-Pet-Credential`) is not masked.
 */
const CREDENTIAL_NAME = /(?:^|[-_])(?:api[-_]?key|key|token|secret|password)$/;

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADERS.has(lower) || CREDENTIAL_NAME.test(lower);
}

function isSensitiveQueryKey(name: string): boolean {
  return CREDENTIAL_NAME.test(name.toLowerCase());
}
const REQUEST_ADMISSION = Symbol.for("@schmock/core.request-admission");

type CoreRequestHandler = (
  method: Schmock.HttpMethod,
  path: string,
  options?: Schmock.RequestOptions,
) => Promise<Schmock.Response>;

interface RequestAdmission {
  handle: CoreRequestHandler;
  release(): void;
}

function isRequestAdmission(value: unknown): value is RequestAdmission {
  return (
    typeof value === "object" &&
    value !== null &&
    "handle" in value &&
    typeof value.handle === "function" &&
    "release" in value &&
    typeof value.release === "function"
  );
}

function acquireRequestAdmission(
  mock: Schmock.CallableMockInstance,
): RequestAdmission | undefined {
  const admit: unknown = Reflect.get(mock, REQUEST_ADMISSION);
  if (typeof admit !== "function") return undefined;

  const admission: unknown = Reflect.apply(admit, mock, []);
  if (!isRequestAdmission(admission)) {
    throw new Error("Schmock returned an invalid request admission");
  }
  return admission;
}

/**
 * What `Access-Control-Allow-Headers` reports when the request names nothing —
 * an ordinary response, or a preflight whose requested list is unusable.
 */
const DEFAULT_ALLOWED_REQUEST_HEADERS = "Content-Type, Authorization";
/** A comma-separated list of RFC 9110 field names, and nothing else. */
const REQUEST_HEADER_LIST =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ \t]*,[ \t]*[!#$%&'*+\-.^_`|~0-9A-Za-z]+)*$/;

type CliIncomingMessage = Parameters<typeof collectBody>[0] &
  Parameters<typeof writeRejectedSchmockResponse>[0] & {
    readonly headers: {
      readonly host?: string;
      readonly [header: string]: string | string[] | undefined;
    };
    readonly method?: string;
    readonly url?: string;
    off(event: "aborted", listener: () => void): unknown;
    once(event: "aborted", listener: () => void): unknown;
  };

class CliHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "CliHttpError";
  }
}

function isCountSource(value: unknown): value is { count: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "count" in value &&
    typeof (value as { count: unknown }).count === "number"
  );
}

/**
 * Resolve a manifest file entry against the manifest directory, refusing escapes.
 *
 * Entries are resolved *then* checked, so an absolute `"/etc/passwd"` is
 * rejected rather than exempted, and both sides are `realpathSync`'d so a
 * symlink planted inside the manifest directory cannot point out of it (and so
 * a macOS `/tmp` → `/private/tmp` manifest still validates).
 */
function resolveSeedEntryPath(
  entry: string,
  key: string,
  baseDir: string,
): string {
  let real: string;
  try {
    real = realpathSync(resolvePath(baseDir, entry));
  } catch {
    throw new Error(`Seed entry "${key}" points to a missing file: ${entry}`);
  }
  const rel = relative(baseDir, real);
  // `relative()` signals an escape only when the FIRST path segment is exactly
  // `..`. A plain `rel.startsWith("..")` also rejects in-directory files whose
  // name merely begins with `..` (e.g. `..data.json`, or a Kubernetes
  // ConfigMap mount whose real path runs through `..2024_.../`), which are
  // wholly inside baseDir. `rel === ""` guards the self-reference `"."`.
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(
      `Seed entry "${key}" must stay inside the seed manifest directory: ${entry}`,
    );
  }
  return real;
}

/**
 * Read a `--seed` manifest.
 *
 * Every entry shape is checked explicitly and anything unrecognised throws:
 * silently dropping a malformed entry used to start a server whose collections
 * were quietly empty. File entries resolve relative to the manifest rather than
 * the process CWD, and may not escape the manifest directory.
 */
export function loadSeedFile(seedPath: string): Schmock.SeedConfig {
  const manifestPath = resolvePath(seedPath);
  // statSync before readFileSync: measuring after the read does not bound it.
  const { size } = statSync(manifestPath);
  if (size > MAX_SEED_MANIFEST_BYTES) {
    throw new ResourceLimitError(
      `seed manifest "${seedPath}"`,
      MAX_SEED_MANIFEST_BYTES,
      size,
    );
  }
  const baseDir = realpathSync(dirname(manifestPath));
  const raw = readFileSync(manifestPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Seed file "${seedPath}" contains invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Seed file must contain a JSON object, got: ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }

  const result: Schmock.SeedConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      result[key] = value;
    } else if (typeof value === "string") {
      result[key] = resolveSeedEntryPath(value, key, baseDir);
    } else if (isCountSource(value)) {
      result[key] = value;
    } else {
      throw new Error(
        `Seed entry "${key}" must be an array, a file path, or { "count": <number> }`,
      );
    }
  }
  return result;
}

/**
 * Whether a request targets the admin surface. Kept as one predicate because
 * two sites depend on the same answer: the CORS preflight short-circuit (which
 * must *not* answer for admin paths) and admin dispatch itself.
 */
function isAdminPath(admin: boolean, path: string): boolean {
  return admin && path.startsWith(ADMIN_PATH_PREFIX);
}

/**
 * A repeated header arrives as an array; treat that as "not presented" rather
 * than joining it, so a duplicated `Authorization` cannot smuggle a token past
 * the comparison.
 */
function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Echo back the headers the browser asked to send, so a preflight for a custom
 * header (`x-my-token`) is not failed by a fixed list.
 *
 * The value is client input on its way to `res.writeHead`, which merges extra
 * headers without revalidating them, so anything that is not a plain field-name
 * list falls back to the default rather than reaching Node — an invalid
 * character there throws and would turn a malformed preflight into a 500.
 */
function requestedAllowHeaders(req: CliIncomingMessage): string {
  const requested = singleHeader(req.headers["access-control-request-headers"]);
  const trimmed = requested?.trim();
  if (trimmed === undefined || trimmed === "") {
    return DEFAULT_ALLOWED_REQUEST_HEADERS;
  }
  return REQUEST_HEADER_LIST.test(trimmed)
    ? trimmed
    : DEFAULT_ALLOWED_REQUEST_HEADERS;
}

/**
 * The CORS headers for one request. A dev-server convenience, not a policy:
 * the origin is always `*`, which is why credentials are never allowed and no
 * `Vary: Origin` is needed.
 */
function corsHeadersFor(req: CliIncomingMessage): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": requestedAllowHeaders(req),
  };
}

/**
 * A browser preflight, as opposed to any other OPTIONS request: both `Origin`
 * and `Access-Control-Request-Method` are present. Answering only these leaves
 * a spec-declared `options` operation reachable, and keeps an unrouted path
 * answering 404 instead of a misleading 204.
 */
function isCorsPreflight(req: CliIncomingMessage, method: string): boolean {
  return (
    method === "OPTIONS" &&
    singleHeader(req.headers.origin) !== undefined &&
    singleHeader(req.headers["access-control-request-method"]) !== undefined
  );
}

function presentedAdminToken(req: CliIncomingMessage): string | undefined {
  const authorization = singleHeader(req.headers.authorization);
  const bearer = authorization
    ? /^bearer\s+(\S+)$/i.exec(authorization.trim())
    : null;
  if (bearer) return bearer[1];
  return singleHeader(req.headers["x-schmock-admin-token"]);
}

/**
 * Constant-time token comparison. Digesting first keeps both operands the same
 * length — `timingSafeEqual` throws outright on a length mismatch, which would
 * otherwise turn a wrong-length token into a 500.
 */
function tokensMatch(expected: string, presented: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const presentedDigest = createHash("sha256").update(presented).digest();
  return timingSafeEqual(expectedDigest, presentedDigest);
}

/**
 * Admin responses never carry CORS headers, are never cached, and vary on
 * `origin` so an intermediary cannot serve one origin's answer to another.
 */
function adminResponseHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    "cache-control": "no-store",
    vary: "origin",
    ...extra,
  };
}

/**
 * Reject an admin request that must not reach {@link handleAdminRequest},
 * returning `true` when it has answered.
 *
 * The `Origin` check runs first and is decisive for cross-origin browser
 * traffic: a browser always sends `Origin` on a cross-origin request, so
 * refusing it blocks local CSRF without leaking whether the token was right.
 * Same-origin requests — including a page reached via DNS rebinding, which
 * sends no `Origin` on a GET — are stopped by the bearer token below, not by
 * this check. Scripted clients (curl, node fetch) send no `Origin` and are
 * unaffected.
 */
function denyAdminRequest(
  req: CliIncomingMessage,
  res: ServerResponse,
  adminToken: string | undefined,
): boolean {
  if (req.headers.origin !== undefined) {
    res.writeHead(403, adminResponseHeaders());
    res.end(
      JSON.stringify({
        error: "Admin API refuses browser-originated requests",
        code: "FORBIDDEN",
      }),
    );
    return true;
  }

  const presented = presentedAdminToken(req);
  if (
    adminToken === undefined ||
    adminToken === "" ||
    presented === undefined ||
    !tokensMatch(adminToken, presented)
  ) {
    res.writeHead(
      401,
      adminResponseHeaders({
        "www-authenticate": 'Bearer realm="schmock-admin"',
      }),
    );
    res.end(
      JSON.stringify({
        error: "Admin API requires a valid bearer token",
        code: "UNAUTHORIZED",
      }),
    );
    return true;
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function redactEntries(
  entries: unknown,
  isSensitive: (name: string) => boolean,
): Record<string, unknown> {
  if (!isRecord(entries)) return {};
  const redacted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(entries)) {
    redacted[name] = isSensitive(name) ? REDACTED : value;
  }
  return redacted;
}

/**
 * Project history for the admin API. New objects throughout — never a mutation
 * of what `mock.history()` returned — so redaction cannot leak back into core.
 */
function redactHistory(records: Schmock.RequestRecord[]): unknown[] {
  return records.map((record) => ({
    ...record,
    query: redactEntries(record.query, isSensitiveQueryKey),
    headers: redactEntries(record.headers, isSensitiveHeader),
  }));
}

function handleAdminRequest(
  method: string,
  path: string,
  mock: Schmock.CallableMockInstance,
  res: ServerResponse,
  headers: Record<string, string>,
): void {
  const route = path.replace(ADMIN_PATH_PREFIX, "");

  if (method === "GET" && route === "routes") {
    res.writeHead(200, headers);
    res.end(JSON.stringify(mock.getRoutes()));
    return;
  }

  if (method === "GET" && route === "state") {
    res.writeHead(200, headers);
    res.end(JSON.stringify(mock.getState()));
    return;
  }

  if (method === "POST" && route === "reset") {
    mock.resetHistory();
    mock.resetState();
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (method === "GET" && route === "history") {
    res.writeHead(200, headers);
    res.end(JSON.stringify(redactHistory(mock.history())));
    return;
  }

  res.writeHead(404, headers);
  res.end(
    JSON.stringify({ error: "Unknown admin endpoint", code: "NOT_FOUND" }),
  );
}

function parseRequestUrl(req: CliIncomingMessage): URL {
  const host = req.headers.host;
  if (!host) {
    throw new CliHttpError(400, "BAD_REQUEST", "Missing Host header");
  }

  try {
    return new URL(req.url ?? "/", `http://${host}`);
  } catch {
    throw new CliHttpError(400, "BAD_REQUEST", "Malformed request target");
  }
}

function parseRequestMethod(req: CliIncomingMessage): Schmock.HttpMethod {
  const method = (req.method ?? "GET").toUpperCase();
  if (!isHttpMethod(method)) {
    throw new CliHttpError(
      405,
      "METHOD_NOT_ALLOWED",
      `Unsupported HTTP method: ${method}`,
      { allow: ALLOWED_METHODS },
    );
  }
  return method;
}

function toCliHttpError(error: unknown): CliHttpError {
  if (error instanceof CliHttpError) return error;
  // No `connection: close` here: it is transport framing, stripped from every
  // route-owned response by normalizeResponse, so the 413 path re-adds it on
  // the extra-headers channel instead.
  if (error instanceof HttpIngressError) {
    return new CliHttpError(error.status, error.code, error.message);
  }

  return new CliHttpError(
    500,
    "SERVER_ERROR",
    error instanceof Error ? error.message : "Internal Server Error",
  );
}

async function handleCliRequest(
  req: CliIncomingMessage,
  res: ServerResponse,
  mock: Schmock.CallableMockInstance,
  options: { admin: boolean; cors: boolean; adminToken?: string },
): Promise<void> {
  const abortController = new AbortController();
  const abortRequest = () => abortController.abort();
  req.once("aborted", abortRequest);
  res.once("close", abortRequest);
  let admission: RequestAdmission | undefined;
  let requestMethod: Schmock.HttpMethod =
    req.method?.toUpperCase() === "HEAD" ? "HEAD" : "GET";
  let adminRequest = false;
  try {
    const url = parseRequestUrl(req);
    const path = url.pathname;
    // Computed before the method parse so the catch below can keep the admin
    // surface CORS-free even for a request whose verb is rejected. Dispatch
    // order is unchanged: an unsupported verb on an admin path still 405s.
    adminRequest = isAdminPath(options.admin, path);
    const method = parseRequestMethod(req);
    requestMethod = method;

    // The preflight short-circuit deliberately excludes the admin surface: it
    // runs before admin dispatch, so without this gate an admin preflight would
    // still be answered 204 + wildcard CORS no matter what the admin branch does.
    if (options.cors && !adminRequest && isCorsPreflight(req, method)) {
      res.writeHead(204, corsHeadersFor(req));
      res.end();
      return;
    }

    if (adminRequest) {
      if (denyAdminRequest(req, res, options.adminToken)) return;
      handleAdminRequest(method, path, mock, res, adminResponseHeaders());
      return;
    }

    admission = acquireRequestAdmission(mock);
    const handleRequest: CoreRequestHandler =
      admission?.handle ??
      ((admittedMethod, requestPath, requestOptions) =>
        mock.handle(admittedMethod, requestPath, requestOptions));
    const headers = parseNodeHeaders(req);
    const query = parseNodeQuery(url);
    const body = await collectBody(req, headers, MAX_REQUEST_BODY_SIZE);
    const schmockResponse = await handleRequest(method, path, {
      headers,
      body,
      query,
      signal: abortController.signal,
    });
    const extraHeaders = options.cors ? corsHeadersFor(req) : undefined;
    writeSchmockResponse(res, schmockResponse, extraHeaders);
  } catch (error) {
    const cliError = toCliHttpError(error);
    try {
      if (cliError.status === 413) res.shouldKeepAlive = false;
      if (!res.headersSent && !res.writableEnded) {
        const response = normalizeResponse(
          {
            status: cliError.status,
            body: { error: cliError.message, code: cliError.code },
            headers: {
              "content-type": "application/json",
              ...cliError.headers,
            },
          },
          requestMethod,
        );
        // `shouldKeepAlive = false` above emits no Connection header on its
        // own, so the close is announced here — after normalization, which
        // strips hop-by-hop headers from anything the mock produced. The
        // admin surface stays CORS-free even on this error path.
        const extraHeaders: Record<string, string> = {
          ...(options.cors && !adminRequest ? corsHeadersFor(req) : {}),
          ...(cliError.status === 413 ? { connection: "close" } : {}),
        };
        if (cliError.status === 413) {
          writeRejectedSchmockResponse(req, res, response, extraHeaders);
        } else {
          writeSchmockResponse(res, response, extraHeaders);
        }
      } else if (!res.writableEnded) {
        res.end();
      }
    } catch {
      res.destroy();
    }
  } finally {
    req.off("aborted", abortRequest);
    res.off("close", abortRequest);
    admission?.release();
  }
}

async function createCliMock(
  options: CliOptions,
): Promise<Schmock.CallableMockInstance> {
  // History exists solely to feed `GET /schmock-admin/history`, so it is off
  // entirely when admin is off — otherwise the CLI accumulates every request
  // and response body for the life of the process with no way to read them.
  const mock = schmock({
    debug: options.debug,
    state: {},
    maxHistorySize: options.admin
      ? (options.adminHistoryLimit ?? DEFAULT_ADMIN_HISTORY_LIMIT)
      : 0,
  });

  const openapiOptions: Parameters<typeof openapi>[0] = {
    spec: options.spec,
    fakerSeed: options.fakerSeed,
    validateRequests: options.errors,
    strict: options.strict,
    refs: {
      external: options.refsExternal ?? false,
      allowHttp: options.refsAllowHttp !== undefined,
      allowedHosts: options.refsAllowHttp,
    },
  };

  if (options.seed) {
    openapiOptions.seed = loadSeedFile(options.seed);
  }

  const plugin = await openapi(openapiOptions);
  mock.pipe(plugin);

  return mock;
}

/**
 * The one mutable cell a reload writes to. The socket, the admin token and the
 * request handler all outlive it, so swapping the mock is the entire reload.
 */
interface MockHolder {
  mock: Schmock.CallableMockInstance;
}

interface OwnedCliServer extends CliServer {
  /** Work that must finish before the socket is released (the spec watcher). */
  onClose(cleanup: () => Promise<void> | void): void;
}

/** Resolve after `ms` without holding the event loop open. */
function boundedDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Stop accepting and settle once the socket is released, bounded by `graceMs`.
 *
 * Node ≥ 19 already drops *idle* keep-alive connections on `close()`, but a
 * request whose body was only half sent never completes on its own: without
 * the grace timer the close callback would never fire and the process could
 * not exit.
 *
 * At the deadline every tracked socket is also destroyed directly. Node's
 * `closeAllConnections()` alone suffices there, but Bun's `node:http` returns
 * from it without releasing a connection whose request body is incomplete, so
 * the close callback never fired and shutdown hung until SIGKILL.
 */
function closeHttpServer({
  httpServer,
  graceMs,
  sockets,
}: {
  httpServer: Server;
  graceMs: number;
  sockets: ReadonlySet<Socket>;
}): Promise<void> {
  return new Promise<void>((resolve) => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      resolve();
    };

    // The callback receives ERR_SERVER_NOT_RUNNING when the socket is already
    // down; closing an already-closed server is a success here, not a failure.
    httpServer.close(() => settle());
    try {
      httpServer.closeIdleConnections();
    } catch {
      // Nothing bound means nothing idle.
    }

    graceTimer = setTimeout(() => {
      try {
        httpServer.closeAllConnections();
      } catch {
        // Already torn down by the close above.
      }
      for (const socket of sockets) socket.destroy();
    }, graceMs);
    // The grace timer must never be the thing holding the event loop open.
    graceTimer.unref();
  });
}

/**
 * Bind one HTTP server for the whole life of the process. Reloads swap
 * {@link MockHolder.mock} behind it rather than rebinding, so the listening
 * socket is never released while the server is meant to be up.
 */
function startCliServer(
  options: CliOptions,
  holder: MockHolder,
): Promise<OwnedCliServer> {
  // `??` only covers null/undefined, so a blank hostname would survive to
  // `listen()` and bind every interface instead of the documented loopback
  // default. `createCliServer` is public, so the guard belongs here too and
  // not only in the flag parser.
  if (options.hostname !== undefined && options.hostname.trim() === "") {
    throw new Error(
      "Invalid hostname. The hostname must be a non-empty host, address or interface.",
    );
  }
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const cors = options.cors ?? false;
  const graceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;

  const admin = options.admin ?? false;
  // Read once, here: a reload swaps only the mock, so the credential a live
  // admin client is holding can never rotate under it.
  const adminToken = admin ? options.adminToken : undefined;

  const httpServer = createServer((req, res) => {
    // Resolved per request: a request already under way keeps the mock it was
    // admitted against, while later requests see the reloaded one.
    void handleCliRequest(req, res, holder.mock, { admin, cors, adminToken });
  });

  // Tracked so the shutdown deadline can release every connection itself
  // rather than trusting the runtime's closeAllConnections (see closeHttpServer).
  const sockets = new Set<Socket>();
  httpServer.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const cleanups: Array<() => Promise<void> | void> = [];
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    // Memoized: a second Ctrl-C, or a teardown that follows an explicit close,
    // observes the same shutdown instead of starting another one.
    closing ??= (async () => {
      // Stop accepting before anything else: the settle starts now, so the
      // socket is released within `graceMs` even while a cleanup (a watcher
      // mid-reload) is still draining.
      const settled = closeHttpServer({ httpServer, graceMs, sockets });
      const drain = (async () => {
        for (const cleanup of cleanups.splice(0)) await cleanup();
      })();
      // A drain that outlives the bound is abandoned rather than reported —
      // there is no caller left to reach — and its observable effects are
      // already suppressed by the watcher's own `closed` flag.
      drain.catch(() => {});
      try {
        // The drain is raced against the same bound the socket close honors,
        // so `close()` settles within `graceMs` as documented instead of
        // blocking on an in-flight spec reload of unbounded duration.
        await Promise.race([drain, boundedDelay(graceMs)]);
      } finally {
        // A cleanup that throws must not strand a bound socket: the close runs
        // either way and the failure still reaches the caller.
        await settled;
      }
    })();
    return closing;
  };

  return new Promise((resolve, reject) => {
    const onListenError = (error: unknown): void => reject(error);
    // A socket-level failure once the server is up (a stray accept error)
    // reached an already-settled `reject` and vanished. Report it and keep
    // serving: a development mock server surviving a stray error is worth more
    // than exiting, and every other CLI diagnostic goes to stderr too.
    const reportServerError = (error: unknown): void => {
      process.stderr.write(
        `Server error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    };

    httpServer.once("error", onListenError);
    httpServer.listen(port, hostname, () => {
      // Attach the permanent reporter BEFORE dropping the startup handler:
      // the other order leaves a window with zero 'error' listeners, in which
      // Node rethrows the event and kills the process.
      httpServer.on("error", reportServerError);
      httpServer.off("error", onListenError);

      const addr = httpServer.address();
      const actualPort =
        addr !== null && typeof addr === "object" ? addr.port : port;

      resolve({
        server: httpServer,
        port: actualPort,
        hostname,
        adminToken,
        close,
        onClose(cleanup) {
          cleanups.push(cleanup);
        },
      });
    });
  });
}

/**
 * Settle the admin token once, at the outermost entry point, so every later
 * consumer (listen, reload, the printed banner) sees the same value.
 */
function resolveAdminToken(options: CliOptions): string | undefined {
  if (!options.admin) return undefined;
  if (options.adminToken === undefined) return randomUUID();
  // The flag parser checks this too, but `createCliServer` is public: an empty
  // token is refused by every admin request, and one containing whitespace
  // (a trailing newline read from a file) can never match a bearer header, so
  // either would start an admin API nobody can use. Fail fast instead.
  if (!isUsableAdminToken(options.adminToken)) {
    throw new Error(
      "Invalid admin token. The token must be non-empty and contain no whitespace.",
    );
  }
  return options.adminToken;
}

function isUsableAdminToken(value: string): boolean {
  return value !== "" && !/\s/.test(value);
}

/** Bracket an IPv6 literal so `http://${host}:${port}` is a parseable URL. */
function formatUrlHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
}

function serverUrl(address: { hostname: string; port: number }): string {
  return `http://${formatUrlHost(address.hostname)}:${address.port}`;
}

export async function createCliServer(options: CliOptions): Promise<CliServer> {
  const resolved: CliOptions = {
    ...options,
    adminToken: resolveAdminToken(options),
  };
  const holder: MockHolder = { mock: await createCliMock(resolved) };
  const server = await startCliServer(resolved, holder);

  if (resolved.watch) {
    let watcher: WatchHandle;
    try {
      watcher = startWatch(resolved, holder, server);
    } catch (error) {
      // A watcher that cannot be created must not leave a bound socket behind:
      // the caller gets the failure and the process can still exit.
      await server.close();
      throw error;
    }
    server.onClose(() => watcher.close());
  }

  return server;
}

/**
 * Loopback binds are `127.0.0.0/8` (also IPv4-mapped, `::ffff:127.x.x.x`),
 * `::1` and `localhost`; everything else is reachable off-box.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:(?=\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$)/, "");
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Decimal digits only. Bare `Number()` reads `""` and `" "` as 0 (a random
 * port) and accepts `0x1F90`, `1e3` and `80.0`, none of which a caller typing
 * a port means; the other numeric flags follow the same rule.
 */
function parseDecimal(value: string, { signed = false } = {}): number {
  const trimmed = value.trim();
  const pattern = signed ? /^-?\d+$/ : /^\d+$/;
  return pattern.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function validatePort(value: string): number {
  const port = parseDecimal(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `Invalid port "${value}". Port must be an integer between 0 and 65535.`,
    );
  }
  return port;
}

/**
 * Core reads a *negative* `maxHistorySize` as "unbounded", so a bad value must
 * be rejected here rather than quietly disabling the cap.
 */
function validateHistoryLimit(value: string): number {
  // `Number("")` is 0, so an empty flag would otherwise read as "keep nothing"
  // instead of the typo it is.
  const limit = parseDecimal(value);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `Invalid --admin-history-limit "${value}". It must be a non-negative integer.`,
    );
  }
  return limit;
}

/**
 * `Number("")` is 0 and `Number("abc")` is NaN, both of which used to reach
 * faker unchallenged — an unseeded run silently pretending to be seeded.
 * Negatives are legal (faker accepts them); a fraction is not, because a seed
 * is an integer and `1.5` was never doing what the caller meant.
 */
function validateFakerSeed(value: string): number {
  const seed = parseDecimal(value, { signed: true });
  if (!Number.isInteger(seed)) {
    throw new Error(
      `Invalid --seed-random "${value}". It must be a finite integer.`,
    );
  }
  return seed;
}

/**
 * An empty hostname is NOT the documented 127.0.0.1 default: `listen(port, "")`
 * binds every interface, exactly as omitting it does, so a typo would silently
 * publish the mock to the network.
 */
function validateHostname(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new Error(
      "Invalid --hostname. The hostname must be a non-empty host, address or interface.",
    );
  }
  return value;
}

function validateAdminToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isUsableAdminToken(value)) {
    throw new Error(
      "Invalid --admin-token. The token must be non-empty and contain no whitespace.",
    );
  }
  return value;
}

export function parseCliArgs(args: string[]): CliOptions & { help: boolean } {
  const { values, positionals } = parseArgs({
    args,
    options: {
      spec: { type: "string" },
      port: { type: "string" },
      hostname: { type: "string" },
      seed: { type: "string" },
      cors: { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      errors: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      admin: { type: "boolean", default: false },
      "admin-token": { type: "string" },
      "admin-history-limit": { type: "string" },
      strict: { type: "boolean", default: false },
      "refs-external": { type: "boolean", default: false },
      "refs-allow-http": { type: "string" },
      "seed-random": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  // Exactly one spec path. Silently discarding the rest turned a shell glob,
  // or a forgotten flag name, into a server for the wrong document.
  if (positionals.length > 1) {
    throw new Error(
      `Unexpected extra arguments: ${positionals.slice(1).join(", ")}. Pass exactly one spec path.`,
    );
  }

  const spec = values.spec ?? positionals[0] ?? "";

  // A token alone used to be dropped silently: the admin paths fell through to
  // the mock and every authenticated call 404'd with no hint why. Implying
  // --admin instead would quietly switch an API on, so this refuses.
  if (values["admin-token"] !== undefined && !values.admin) {
    throw new Error("--admin-token requires --admin.");
  }

  return {
    spec,
    // `=== undefined`, not truthiness: `--port=` (an unset shell variable) is
    // a typo to reject, not a request for the 3000 default.
    port: values.port === undefined ? undefined : validatePort(values.port),
    hostname: validateHostname(values.hostname),
    seed: values.seed,
    cors: values.cors,
    debug: values.debug,
    errors: values.errors,
    watch: values.watch,
    admin: values.admin,
    adminToken: validateAdminToken(values["admin-token"]),
    adminHistoryLimit:
      values["admin-history-limit"] === undefined
        ? undefined
        : validateHistoryLimit(values["admin-history-limit"]),
    strict: values.strict,
    refsExternal: values["refs-external"],
    refsAllowHttp: parseAllowedHosts(values["refs-allow-http"]),
    fakerSeed:
      values["seed-random"] === undefined
        ? undefined
        : validateFakerSeed(values["seed-random"]),
    help: values.help ?? false,
  };
}

/**
 * `--refs-allow-http a.test,b.test` — an empty list is still meaningful: it
 * turns http resolution on with no host restriction beyond the built-in block
 * on loopback, link-local and private addresses.
 */
function parseAllowedHosts(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

const USAGE = `Usage: schmock <spec> [options]
       schmock --spec <path> [options]

Options:
  --spec <path>       OpenAPI/Swagger spec file (or pass as first argument)
  --port <number>     Port to listen on (default: 3000)
  --hostname <host>   Hostname to bind to (default: 127.0.0.1)
  --seed <path>       JSON file with seed data
  --cors              Enable CORS for mock responses (never for /schmock-admin/*)
  --debug             Enable debug logging
  --errors            Enable request body validation against spec
  --watch             Watch spec file and hot-reload on changes
  --admin             Enable /schmock-admin/* introspection endpoints
  --admin-token <token>
                      Bearer token required by /schmock-admin/*. Generated and
                      printed to stderr when --admin is set without it.
  --admin-history-limit <n>
                      Requests retained for /schmock-admin/history (default: 500).
                      Without --admin no history is retained at all.
  --strict            Validate the spec against the OpenAPI schema at startup
  --refs-external     Resolve $refs to files outside the spec document
  --refs-allow-http <hosts>
                      Also resolve http(s) $refs, limited to this comma-separated
                      host list (empty list = any public host). Requires
                      --refs-external.
  --seed-random <n>   Seed for deterministic random generation
  -h, --help          Show this help message
`;

const WATCH_DEBOUNCE_MS = 500;

interface WatchHandle {
  /** Resolves once the watcher is shut and any in-flight reload has settled. */
  close(): Promise<void>;
}

/**
 * Build the replacement mock first and only then publish it. A spec that no
 * longer parses therefore leaves the running mock untouched, and because the
 * socket is never involved there is no window in which the port is unbound.
 */
async function reloadMock(
  holder: MockHolder,
  options: CliOptions,
): Promise<void> {
  const previous = holder.mock;
  holder.mock = await createCliMock(options);
  // Retire the instance nothing will use again, so its plugins' `uninstall`
  // hooks actually run — a reload used to drop it on the floor. Order matters
  // twice: resetting BEFORE the swap would blank the live mock, and a
  // `createCliMock` that threw must leave the old mock serving (the "invalid
  // spec changes keep the current server online" contract), which the `await`
  // above guarantees by never reaching this line.
  //
  // In-flight requests are safe: every request path acquires a core admission
  // first, and an admission snapshots routes, plugins, state and the history
  // generation, so it keeps serving from its snapshot while core defers the
  // uninstall until the last admission releases.
  try {
    previous.reset();
  } catch {
    // Core already logs a per-plugin uninstall failure. A discarded instance
    // failing to tidy up must not fail the reload that already succeeded.
  }
}

/**
 * What one directory watch reacts to: the named entries in it, or every entry
 * (`"any"`) for the spec's directory when `$ref`s may point at sibling files.
 */
type WatchMatcher = ReadonlySet<string> | "any";

/**
 * The file entries a `--seed` manifest names, as `loadSeedFile` resolves them.
 * A manifest that does not load yields none: the reload reports its own error,
 * and the manifest itself stays watched so fixing it triggers the next reload.
 */
function seedEntryFiles(seedPath: string): string[] {
  try {
    return Object.values(loadSeedFile(seedPath)).filter(
      (source): source is string => typeof source === "string",
    );
  } catch {
    return [];
  }
}

function realDirectory(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/**
 * Every file a reload reads, grouped by the directory to watch it through:
 * the spec, the `--seed` manifest and each file entry it names. With
 * `--refs-external` the spec's whole directory counts, because a `$ref`'d
 * sibling schema file is part of the contract. A `$ref` target in another
 * directory is still not watched: the openapi plugin does not report which
 * files it resolved.
 */
function collectWatchTargets(options: CliOptions): Map<string, WatchMatcher> {
  const targets = new Map<string, Set<string> | "any">();
  const addFile = (path: string): void => {
    const directory = dirname(path);
    const current = targets.get(directory);
    if (current === "any") return;
    if (current) current.add(basename(path));
    else targets.set(directory, new Set([basename(path)]));
  };

  const resolvedSpec = resolvePath(options.spec);
  if (options.refsExternal) targets.set(dirname(resolvedSpec), "any");
  else addFile(resolvedSpec);

  if (options.seed !== undefined) {
    const manifest = resolvePath(options.seed);
    const manifestDirectory = dirname(manifest);
    addFile(manifest);
    const realManifestDirectory = realDirectory(manifestDirectory);
    for (const entry of seedEntryFiles(options.seed)) {
      // Entries come back realpath'd. Re-anchoring them on the manifest
      // directory as the user named it keeps one directory from being watched
      // twice under two spellings (macOS `/var` vs `/private/var`).
      addFile(
        resolvePath(manifestDirectory, relative(realManifestDirectory, entry)),
      );
    }
  }
  return targets;
}

/**
 * Some platforms report an in-place write under the watched DIRECTORY's own
 * name rather than the file's, so that spelling counts as ours too. A null
 * filename is likewise treated as possibly-ours — the debounce absorbs the
 * duplicate — while a named unrelated sibling is skipped so an unrelated write
 * in a watched directory does not rebuild the mock.
 */
function matchesWatchTarget(
  matcher: WatchMatcher,
  directory: string,
  filename: string | Buffer | null,
): boolean {
  if (filename == null || matcher === "any") return true;
  const name = basename(filename.toString());
  return matcher.has(name) || name === basename(directory);
}

/**
 * Watch the spec (and everything else a reload reads) and hot-swap the mock
 * behind the live server on changes.
 *
 * The watch is on each file's DIRECTORY, not the file itself. `fs.watch` on a
 * file follows its inode, so the first atomic editor save — write a sibling
 * temp file, rename it over the target, which is what vim, JetBrains and VS
 * Code all do — leaves the watcher bound to the replaced inode and silently
 * deaf to every later edit. A directory watch sees the rename, keeps seeing
 * later in-place writes, and re-arms for free when a file is deleted and
 * recreated. It is non-recursive, so a large tree under a watched directory
 * costs nothing. One watcher serves each directory, and the set is re-derived
 * after every reload so a seed manifest that names new files is followed.
 *
 * Paths are resolved with `resolve`, deliberately NOT `realpathSync`: a
 * symlinked spec must keep watching the directory the user actually named.
 * (Consequence: an editor saving the symlink's TARGET, in another directory,
 * fires no event. Watching the target instead would break the far commoner
 * case of a linked spec edited in place.)
 */
function startWatch(
  options: CliOptions,
  holder: MockHolder,
  address: { hostname: string; port: number },
): WatchHandle {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let reloadQueue = Promise.resolve();
  let targets = collectWatchTargets(options);
  const watchers = new Map<string, FSWatcher>();

  const reportWatchError = (error: unknown): void => {
    process.stderr.write(
      `Spec watch error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  };

  const closeWatchers = (): void => {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };

  // Follow a changed file set: drop directories no longer needed and watch
  // new ones. A directory that cannot be watched is reported, not fatal — the
  // server keeps serving and the other watches keep working.
  const rearm = (): void => {
    if (closed) return;
    targets = collectWatchTargets(options);
    for (const [directory, watcher] of watchers) {
      if (targets.has(directory)) continue;
      watcher.close();
      watchers.delete(directory);
    }
    for (const directory of targets.keys()) {
      if (watchers.has(directory)) continue;
      try {
        watchers.set(directory, watchDirectory(directory));
      } catch (error) {
        reportWatchError(error);
      }
    }
  };

  const scheduleReload = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      reloadQueue = reloadQueue.then(async () => {
        if (closed) return;
        process.stderr.write("\nSpec changed, reloading...\n");
        try {
          await reloadMock(holder, options);
          if (closed) return;
          // A reload builds a fresh mock, so CRUD rows created since startup
          // and the admin history are gone; `--seed` data is re-applied.
          process.stderr.write(
            `Schmock server reloaded on ${serverUrl(address)} (state and request history reset)\n`,
          );
        } catch (err) {
          if (closed) return;
          process.stderr.write(
            `Reload failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        rearm();
      });
    }, WATCH_DEBOUNCE_MS);
  };

  function watchDirectory(directory: string): FSWatcher {
    const watcher = watch(directory, (_event, filename) => {
      if (closed) return;
      const matcher = targets.get(directory);
      if (matcher === undefined) return;
      if (!matchesWatchTarget(matcher, directory, filename)) return;
      scheduleReload();
    });
    // An unhandled 'error' event (the directory unmounted, an unlink race)
    // would take the whole process down; watching is a convenience, so it is
    // reported and the server keeps serving the mock it already has.
    watcher.on("error", reportWatchError);
    return watcher;
  }

  try {
    for (const directory of targets.keys()) {
      watchers.set(directory, watchDirectory(directory));
    }
  } catch (error) {
    // The caller releases the socket; the watches already made go too.
    closeWatchers();
    throw error;
  }

  return {
    async close() {
      closed = true;
      closeWatchers();
      if (debounceTimer) clearTimeout(debounceTimer);
      // A reload already parsing must be awaited: otherwise it would swap the
      // mock, or write to stderr, after shutdown has reported itself complete.
      await reloadQueue;
    },
  };
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  // Settle the admin token before anything else reads the options object: the
  // banner below prints it and `createCliServer` binds it to the socket, so
  // minting it any later would print one token and enforce another.
  const options = { ...parsed, adminToken: resolveAdminToken(parsed) };

  if (options.help) {
    process.stderr.write(USAGE);
    return;
  }

  if (!options.spec) {
    process.stderr.write("Error: --spec is required\n\n");
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }

  const cliServer = await createCliServer(options);

  process.stderr.write(`Schmock server running on ${serverUrl(cliServer)}\n`);
  process.stderr.write(`Spec: ${options.spec}\n`);
  if (options.cors) {
    process.stderr.write("CORS: enabled\n");
  }
  if (options.admin) {
    process.stderr.write("Admin: enabled (/schmock-admin/*)\n");
    process.stderr.write(`Admin token: ${options.adminToken}\n`);
    if (!isLoopbackHost(cliServer.hostname)) {
      process.stderr.write(
        `WARNING: the admin API is enabled and bound to ${cliServer.hostname}, which is reachable from other hosts.\n` +
          "WARNING: anyone who can reach this port and the admin token can read recorded requests and reset the mock.\n",
      );
    }
  } else if (options.adminHistoryLimit !== undefined) {
    process.stderr.write(
      "WARNING: --admin-history-limit has no effect without --admin; no history is retained.\n",
    );
  }

  if (options.watch) {
    // The watcher belongs to the server now; `run` only reports it.
    process.stderr.write("Watch: enabled\n");
  }

  // `run` owns the handlers it registers. They stay attached until the close
  // settles — dropping the last listener any earlier would restore the
  // signal's default disposition and let a second Ctrl-C hard-kill the
  // process mid-drain; the `shuttingDown` guard absorbs it instead. The
  // returned promise settles when shutdown finishes, which is what lets
  // `bin.ts`'s `.catch` cover a failing close.
  const graceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  return new Promise<void>((resolveRun, rejectRun) => {
    let shuttingDown = false;
    let repeatReported = false;
    let forceExitAfter = Number.POSITIVE_INFINITY;

    const shutdown = (): void => {
      if (shuttingDown) {
        // `close()` is bounded by the grace window, so one still running past
        // it is wedged (a runtime that cannot drop a stalled connection). A
        // signal then is the user's only way out short of SIGKILL.
        if (Date.now() >= forceExitAfter) {
          process.stderr.write(
            "Shutdown did not finish within the grace window; forcing exit.\n",
          );
          process.exit(1);
          return;
        }
        // The handlers stay attached on purpose (see above), so a repeat
        // Ctrl-C during the grace window used to vanish with no output at all
        // and no way to tell whether it had been received. Reported once, so
        // holding the key down does not bury the shutdown log.
        if (!repeatReported) {
          repeatReported = true;
          process.stderr.write(
            `Shutdown already in progress; waiting for in-flight requests (signal again after ${graceMs} ms to force an exit)...\n`,
          );
        }
        return;
      }
      shuttingDown = true;
      forceExitAfter = Date.now() + graceMs;
      process.stderr.write("\nShutting down...\n");
      const release = (): void => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
      };
      void cliServer.close().then(
        (value) => {
          release();
          resolveRun(value);
        },
        (error: unknown) => {
          release();
          rejectRun(error);
        },
      );
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
