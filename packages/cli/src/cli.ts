/// <reference path="../../../types/schmock.d.ts" />

import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { schmock, toHttpMethod } from "@schmock/core";
import type { SeedConfig } from "@schmock/openapi";
import { openapi } from "@schmock/openapi";

export interface CliOptions {
  spec: string;
  port?: number;
  hostname?: string;
  seed?: string;
  cors?: boolean;
  debug?: boolean;
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

function isSeedSource(value: unknown): value is SeedConfig[string] {
  return (
    Array.isArray(value) ||
    typeof value === "string" ||
    (typeof value === "object" && value !== null && "count" in value)
  );
}

function loadSeedFile(seedPath: string): SeedConfig {
  const raw = readFileSync(seedPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Seed file must contain a JSON object, got: ${typeof parsed}`,
    );
  }
  const result: SeedConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isSeedSource(value)) {
      result[key] = value;
    }
  }
  return result;
}

export async function createCliServer(options: CliOptions): Promise<CliServer> {
  const mock = schmock({ debug: options.debug });

  const openapiOptions: Parameters<typeof openapi>[0] = {
    spec: options.spec,
  };

  if (options.seed) {
    openapiOptions.seed = loadSeedFile(options.seed);
  }

  const plugin = await openapi(openapiOptions);
  mock.pipe(plugin);

  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const cors = options.cors ?? false;

  const httpServer = createServer((req, res) => {
    // Handle CORS preflight
    if (cors && req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = toHttpMethod(req.method ?? "GET");
    const path = url.pathname;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers[key] = value;
      }
    }

    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      let body: unknown;
      const contentType = headers["content-type"] ?? "";
      if (raw && contentType.includes("json")) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      } else if (raw) {
        body = raw;
      }

      void mock
        .handle(method, path, { headers, body, query })
        .then((schmockResponse) => {
          const responseHeaders: Record<string, string> = {
            ...schmockResponse.headers,
          };

          if (cors) {
            Object.assign(responseHeaders, CORS_HEADERS);
          }

          if (
            !responseHeaders["content-type"] &&
            schmockResponse.body !== undefined &&
            typeof schmockResponse.body !== "string"
          ) {
            responseHeaders["content-type"] = "application/json";
          }

          const responseBody =
            schmockResponse.body === undefined
              ? undefined
              : typeof schmockResponse.body === "string"
                ? schmockResponse.body
                : JSON.stringify(schmockResponse.body);

          res.writeHead(schmockResponse.status, responseHeaders);
          res.end(responseBody);
        });
    });
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
  -h, --help          Show this help message
`;

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

  const cliServer = await createCliServer(options);

  process.stderr.write(
    `Schmock server running on http://${cliServer.hostname}:${cliServer.port}\n`,
  );
  process.stderr.write(`Spec: ${options.spec}\n`);
  if (options.cors) {
    process.stderr.write("CORS: enabled\n");
  }

  const shutdown = () => {
    process.stderr.write("\nShutting down...\n");
    cliServer.close();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
