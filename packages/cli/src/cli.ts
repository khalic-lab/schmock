/// <reference path="../../core/schmock.d.ts" />

import { readFileSync, watch } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import {
  collectBody,
  parseNodeHeaders,
  parseNodeQuery,
  schmock,
  toHttpMethod,
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

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
};

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
  res: import("node:http").ServerResponse,
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

export async function createCliServer(options: CliOptions): Promise<CliServer> {
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

  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const cors = options.cors ?? false;

  const admin = options.admin ?? false;

  const httpServer = createServer((req, res) => {
    // Handle CORS preflight
    if (cors && req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;

    // Admin API intercept
    if (admin && path.startsWith("/schmock-admin/")) {
      const adminHeaders: Record<string, string> = {
        "content-type": "application/json",
        ...(cors ? CORS_HEADERS : {}),
      };
      handleAdminRequest(req.method ?? "GET", path, mock, res, adminHeaders);
      return;
    }

    const method = toHttpMethod(req.method ?? "GET");
    const headers = parseNodeHeaders(req);
    const query = parseNodeQuery(url);

    void collectBody(req, headers).then((body) =>
      mock
        .handle(method, path, { headers, body, query })
        .then((schmockResponse) => {
          const extra = cors ? CORS_HEADERS : undefined;
          writeSchmockResponse(res, schmockResponse, extra);
        }),
    );
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
    port: values.port ? Number(values.port) : undefined,
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
 * Reload a CLI server: close the old one, create a new one on the same port.
 */
export async function reloadServer(
  current: CliServer,
  options: CliOptions,
): Promise<CliServer> {
  const port = current.port;
  // Close existing connections and wait for the server to fully close
  current.server.closeAllConnections();
  await new Promise<void>((resolve) => {
    current.server.close(() => resolve());
  });
  return createCliServer({ ...options, port });
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

  const watcher = watch(specPath, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      process.stderr.write("\nSpec changed, reloading...\n");
      try {
        const newServer = await reloadServer(getCurrentServer(), options);
        onReload(newServer);
        process.stderr.write(
          `Schmock server reloaded on http://${newServer.hostname}:${newServer.port}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `Reload failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }, WATCH_DEBOUNCE_MS);
  });

  return {
    close() {
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
