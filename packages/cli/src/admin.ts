import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type * as Schmock from "@schmock/core";
import { SchmockError, SENSITIVE_HEADER_NAMES } from "@schmock/core";
import { isCredentialName } from "@schmock/core/adapter";
import type { HeaderSource } from "./cors.js";
import { singleHeader } from "./cors.js";
import type { CliOptions } from "./types.js";

const ADMIN_PATH_PREFIX = "/schmock-admin/";
/**
 * Requests retained for `GET /schmock-admin/history` when
 * `--admin-history-limit` is not given. Core's own `maxHistorySize` defaults
 * to unbounded, which a server left running all day cannot afford.
 */
export const DEFAULT_ADMIN_HISTORY_LIMIT = 500;
const REDACTED = "[redacted]";

/**
 * Header names whose values the admin history projection masks: core's
 * credential header set (the one its debug log masks) plus anything named like
 * a credential by core's `isCredentialName` rule (`X-Pet-Key`,
 * `access_token`, `client_secret`). The openapi plugin does not expose the
 * apiKey scheme names a spec declares, so that rule catches the conventional
 * spellings of them; a name outside it (`X-Pet-Credential`) is not masked.
 * Core's `redactHeaders` is not used because it masks only the header set,
 * and only in a string record.
 *
 * Redaction is deliberately confined to this projection: `mock.history()` is
 * public core API and library users legitimately assert on the raw values.
 */
function isSensitiveHeader(name: string): boolean {
  return (
    SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) || isCredentialName(name)
  );
}

/** The rule core's debug log masks query parameters by, so the two agree. */
const isSensitiveQueryKey = isCredentialName;

/**
 * Whether a request targets the admin surface. Kept as one predicate because
 * two sites depend on the same answer: the CORS decisions (the preflight
 * short-circuit and the extra headers, which must *not* apply to admin paths)
 * and admin dispatch itself.
 */
export function isAdminPath(admin: boolean, path: string): boolean {
  return admin && path.startsWith(ADMIN_PATH_PREFIX);
}

function presentedAdminToken(req: HeaderSource): string | undefined {
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
 * The body is pre-serialized JSON, so the bytes are exactly what
 * `JSON.stringify` produced.
 */
function adminResponse(
  status: number,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Schmock.Response {
  return {
    status,
    body,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      vary: "origin",
      ...extraHeaders,
    },
  };
}

/**
 * The refusal for an admin request that must not reach
 * {@link dispatchAdminRequest}, or `undefined` when it may.
 *
 * The `Origin` check runs first and is decisive for cross-origin browser
 * traffic: a browser always sends `Origin` on a cross-origin request, so
 * refusing it blocks local CSRF without leaking whether the token was right.
 * Same-origin requests — including a page reached via DNS rebinding, which
 * sends no `Origin` on a GET — are stopped by the bearer token below, not by
 * this check. Scripted clients (curl, node fetch) send no `Origin` and are
 * unaffected.
 */
function refuseAdminRequest(
  req: HeaderSource,
  adminToken: string | undefined,
): Schmock.Response | undefined {
  if (req.headers.origin !== undefined) {
    return adminResponse(
      403,
      JSON.stringify({
        error: "Admin API refuses browser-originated requests",
        code: "FORBIDDEN",
      }),
    );
  }

  const presented = presentedAdminToken(req);
  if (
    adminToken === undefined ||
    adminToken === "" ||
    presented === undefined ||
    !tokensMatch(adminToken, presented)
  ) {
    return adminResponse(
      401,
      JSON.stringify({
        error: "Admin API requires a valid bearer token",
        code: "UNAUTHORIZED",
      }),
      { "www-authenticate": 'Bearer realm="schmock-admin"' },
    );
  }

  return undefined;
}

/** Any non-null object, arrays included, whose own entries can be listed. */
function isObjectLike(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function redactEntries(
  entries: unknown,
  isSensitive: (name: string) => boolean,
): Record<string, unknown> {
  if (!isObjectLike(entries)) return {};
  // `Object.fromEntries` defines each key, so one named `__proto__` (which
  // core records as an own entry) stays an entry instead of hitting the
  // prototype setter and vanishing.
  return Object.fromEntries(
    Object.entries(entries).map(([name, value]) => [
      name,
      isSensitive(name) ? REDACTED : value,
    ]),
  );
}

/**
 * A recorded body as the history projection shows it. `JSON.stringify` turns
 * an `ArrayBuffer` into `{}`, indistinguishable from an empty JSON object, and
 * a typed array into one key per byte, so a binary body is shown by its size.
 * (A multipart body needs nothing here: core records a `FormData` as its own
 * `{ kind: "unavailable" }` descriptor.)
 */
function describeBody(body: unknown): unknown {
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return { kind: "binary", byteLength: body.byteLength };
  }
  return body;
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
    body: describeBody(record.body),
    response: isObjectLike(record.response)
      ? { ...record.response, body: describeBody(record.response.body) }
      : record.response,
  }));
}

export interface AdminRequest {
  /** The raw request, for the `Origin` check and the presented token. */
  readonly req: HeaderSource;
  readonly method: Schmock.HttpMethod;
  readonly path: string;
  readonly mock: Schmock.CallableMockInstance;
  /** The token every admin request must present; see `resolveAdminToken`. */
  readonly adminToken: string | undefined;
}

function dispatchAdminRequest({
  method,
  path,
  mock,
}: AdminRequest): Schmock.Response {
  const route = path.replace(ADMIN_PATH_PREFIX, "");

  if (method === "GET" && route === "routes") {
    return adminResponse(200, JSON.stringify(mock.getRoutes()));
  }

  if (method === "GET" && route === "state") {
    return adminResponse(200, JSON.stringify(mock.getState()));
  }

  if (method === "POST" && route === "reset") {
    mock.resetHistory();
    mock.resetState();
    return adminResponse(204);
  }

  if (method === "GET" && route === "history") {
    return adminResponse(200, JSON.stringify(redactHistory(mock.history())));
  }

  return adminResponse(
    404,
    JSON.stringify({ error: "Unknown admin endpoint", code: "NOT_FOUND" }),
  );
}

/**
 * Answer a request on the admin surface ({@link isAdminPath}): a refusal
 * unless it presents the admin token without an `Origin`, otherwise the
 * endpoint's answer. Throws only when the mock's routes or state cannot be
 * serialized.
 */
export function answerAdminRequest(request: AdminRequest): Schmock.Response {
  return (
    refuseAdminRequest(request.req, request.adminToken) ??
    dispatchAdminRequest(request)
  );
}

/**
 * Whether a token can be presented at all. Node reads header bytes as
 * Latin-1, so a token outside visible ASCII (`tökén`, a zero-width space)
 * never equals what curl or fetch sends, and fetch refuses some outright.
 */
export function isUsableAdminToken(value: string): boolean {
  return /^[\x21-\x7E]+$/.test(value);
}

/**
 * Settle the admin token once, at the outermost entry point, so every later
 * consumer (listen, reload, the printed banner) sees the same value.
 *
 * @throws SchmockError `INVALID_CONFIG` for an empty token or one containing
 *   whitespace or anything outside visible ASCII
 */
export function resolveAdminToken(options: CliOptions): string | undefined {
  if (!options.admin) return undefined;
  if (options.adminToken === undefined) return randomUUID();
  // The flag parser checks this too, but `createCliServer` is public: an empty
  // token is refused by every admin request, and one containing whitespace
  // (a trailing newline read from a file) or a non-ASCII character can never
  // match a bearer header, so any of them would start an admin API nobody can
  // use. Fail fast instead.
  if (!isUsableAdminToken(options.adminToken)) {
    // The context names the option only: the value is a credential.
    throw new SchmockError(
      "Invalid admin token. The token must be non-empty visible ASCII with no whitespace.",
      "INVALID_CONFIG",
      { option: "adminToken" },
    );
  }
  return options.adminToken;
}
