import { readFileSync, watch } from "node:fs";
import type { Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
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
  schmock,
  writeRejectedSchmockResponse,
  writeSchmockResponse,
} from "@schmock/core";
import { openapi } from "@schmock/openapi";

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
}

export interface CliServer {
  server: Server;
  port: number;
  hostname: string;
  close(): void;
}

const MAX_REQUEST_BODY_SIZE = 10 * 1024 * 1024;
const ALLOWED_METHODS = HTTP_METHODS.join(", ");
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

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": ALLOWED_METHODS,
  "access-control-allow-headers": "Content-Type, Authorization",
};

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

function isSeedSource(value: unknown): value is Schmock.SeedConfig[string] {
  return (
    Array.isArray(value) ||
    typeof value === "string" ||
    (typeof value === "object" && value !== null && "count" in value)
  );
}

function loadSeedFile(seedPath: string): Schmock.SeedConfig {
  const raw = readFileSync(seedPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Seed file must contain a JSON object, got: ${typeof parsed}`,
    );
  }
  const result: Schmock.SeedConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isSeedSource(value)) {
      result[key] = value;
    }
  }
  return result;
}

function handleAdminRequest(
  method: string,
  path: string,
  mock: Schmock.CallableMockInstance,
  res: ServerResponse,
  headers: Record<string, string>,
): void {
  const route = path.replace("/schmock-admin/", "");

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
    res.end(JSON.stringify(mock.history()));
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
  if (error instanceof HttpIngressError) {
    return new CliHttpError(
      error.status,
      error.code,
      error.message,
      error.status === 413 ? { connection: "close" } : undefined,
    );
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
  options: { admin: boolean; cors: boolean },
): Promise<void> {
  const abortController = new AbortController();
  const abortRequest = () => abortController.abort();
  req.once("aborted", abortRequest);
  res.once("close", abortRequest);
  let admission: RequestAdmission | undefined;
  let requestMethod: Schmock.HttpMethod =
    req.method?.toUpperCase() === "HEAD" ? "HEAD" : "GET";
  try {
    const url = parseRequestUrl(req);
    const method = parseRequestMethod(req);
    requestMethod = method;
    const path = url.pathname;

    if (options.cors && method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (options.admin && path.startsWith("/schmock-admin/")) {
      const adminHeaders: Record<string, string> = {
        "content-type": "application/json",
        ...(options.cors ? CORS_HEADERS : {}),
      };
      handleAdminRequest(method, path, mock, res, adminHeaders);
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
    const extraHeaders = options.cors ? CORS_HEADERS : undefined;
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
        const extraHeaders = options.cors ? CORS_HEADERS : undefined;
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
  const mock = schmock({ debug: options.debug, state: {} });

  const openapiOptions: Parameters<typeof openapi>[0] = {
    spec: options.spec,
    fakerSeed: options.fakerSeed,
    validateRequests: options.errors,
  };

  if (options.seed) {
    openapiOptions.seed = loadSeedFile(options.seed);
  }

  const plugin = await openapi(openapiOptions);
  mock.pipe(plugin);

  return mock;
}

function listenWithMock(
  options: CliOptions,
  mock: Schmock.CallableMockInstance,
): Promise<CliServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const cors = options.cors ?? false;

  const admin = options.admin ?? false;

  const httpServer = createServer((req, res) => {
    void handleCliRequest(req, res, mock, { admin, cors });
  });

  return new Promise((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, hostname, () => {
      const addr = httpServer.address();
      const actualPort =
        addr !== null && typeof addr === "object" ? addr.port : port;

      resolve({
        server: httpServer,
        port: actualPort,
        hostname,
        close() {
          httpServer.close();
        },
      });
    });
  });
}

export async function createCliServer(options: CliOptions): Promise<CliServer> {
  const mock = await createCliMock(options);
  return listenWithMock(options, mock);
}

function validatePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `Invalid port "${value}". Port must be an integer between 0 and 65535.`,
    );
  }
  return port;
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
      "seed-random": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const spec = values.spec ?? positionals[0] ?? "";

  return {
    spec,
    port: values.port ? validatePort(values.port) : undefined,
    hostname: values.hostname,
    seed: values.seed,
    cors: values.cors,
    debug: values.debug,
    errors: values.errors,
    watch: values.watch,
    admin: values.admin,
    fakerSeed: values["seed-random"]
      ? Number(values["seed-random"])
      : undefined,
    help: values.help ?? false,
  };
}

const USAGE = `Usage: schmock <spec> [options]
       schmock --spec <path> [options]

Options:
  --spec <path>       OpenAPI/Swagger spec file (or pass as first argument)
  --port <number>     Port to listen on (default: 3000)
  --hostname <host>   Hostname to bind to (default: 127.0.0.1)
  --seed <path>       JSON file with seed data
  --cors              Enable CORS for all responses
  --debug             Enable debug logging
  --errors            Enable request body validation against spec
  --watch             Watch spec file and hot-reload on changes
  --admin             Enable /schmock-admin/* introspection endpoints
  --seed-random <n>   Seed for deterministic random generation
  -h, --help          Show this help message
`;

const WATCH_DEBOUNCE_MS = 500;

export interface WatchHandle {
  close(): void;
}

/**
 * Prepare a replacement before closing the live server, then bind it to the
 * same port. Invalid spec changes therefore leave the current server online.
 */
export async function reloadServer(
  current: CliServer,
  options: CliOptions,
): Promise<CliServer> {
  const port = current.port;
  const nextOptions = { ...options, port };
  const replacementMock = await createCliMock(nextOptions);

  // Close existing connections and wait for the server to fully close
  current.server.closeAllConnections();
  await new Promise<void>((resolve) => {
    current.server.close(() => resolve());
  });
  return listenWithMock(nextOptions, replacementMock);
}

/**
 * Watch a spec file and hot-reload the server on changes.
 */
export function startWatch(
  specPath: string,
  options: CliOptions,
  getCurrentServer: () => CliServer,
  onReload: (server: CliServer) => void,
): WatchHandle {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let reloadQueue = Promise.resolve();

  const watcher = watch(specPath, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      reloadQueue = reloadQueue.then(async () => {
        if (closed) return;
        process.stderr.write("\nSpec changed, reloading...\n");
        try {
          const newServer = await reloadServer(getCurrentServer(), options);
          if (closed) {
            newServer.close();
            return;
          }
          onReload(newServer);
          process.stderr.write(
            `Schmock server reloaded on http://${newServer.hostname}:${newServer.port}\n`,
          );
        } catch (err) {
          process.stderr.write(
            `Reload failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      });
    }, WATCH_DEBOUNCE_MS);
  });

  return {
    close() {
      closed = true;
      watcher.close();
      if (debounceTimer) clearTimeout(debounceTimer);
    },
  };
}

export async function run(args: string[]): Promise<void> {
  const options = parseCliArgs(args);

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

  let cliServer = await createCliServer(options);

  process.stderr.write(
    `Schmock server running on http://${cliServer.hostname}:${cliServer.port}\n`,
  );
  process.stderr.write(`Spec: ${options.spec}\n`);
  if (options.cors) {
    process.stderr.write("CORS: enabled\n");
  }
  if (options.admin) {
    process.stderr.write("Admin: enabled (/schmock-admin/*)\n");
  }

  let watchHandle: WatchHandle | undefined;
  if (options.watch) {
    watchHandle = startWatch(
      options.spec,
      options,
      () => cliServer,
      (newServer) => {
        cliServer = newServer;
      },
    );
    process.stderr.write("Watch: enabled\n");
  }

  const shutdown = () => {
    process.stderr.write("\nShutting down...\n");
    watchHandle?.close();
    cliServer.close();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
