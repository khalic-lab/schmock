import { parseArgs } from "node:util";
import { SchmockError } from "@schmock/core";
import { isUsableAdminToken } from "./admin.js";
import type { CliOptions } from "./types.js";

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
 * A flag value the CLI refuses. `bin.ts` prints the message as-is, so it names
 * the flag; the context carries the flag for callers of `parseCliArgs`.
 */
function invalidFlag(
  message: string,
  context: { flag: string; value?: string },
): SchmockError {
  return new SchmockError(message, "INVALID_CONFIG", context);
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
    throw invalidFlag(
      `Invalid port "${value}". Port must be an integer between 0 and 65535.`,
      { flag: "--port", value },
    );
  }
  return port;
}

/**
 * Checked here even though core rejects a negative `maxHistorySize` itself
 * (`INVALID_CONFIG`): core only receives the limit while `--admin` is on, so
 * without this check a bad value next to a missing `--admin` would pass
 * silently, and core's message names its option rather than this flag.
 */
function validateHistoryLimit(value: string): number {
  // `Number("")` is 0, so an empty flag would otherwise read as "keep nothing"
  // instead of the typo it is.
  const limit = parseDecimal(value);
  if (!Number.isInteger(limit) || limit < 0) {
    throw invalidFlag(
      `Invalid --admin-history-limit "${value}". It must be a non-negative integer.`,
      { flag: "--admin-history-limit", value },
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
    throw invalidFlag(
      `Invalid --seed-random "${value}". It must be a finite integer.`,
      { flag: "--seed-random", value },
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
    throw invalidFlag(
      "Invalid --hostname. The hostname must be a non-empty host, address or interface.",
      { flag: "--hostname", value },
    );
  }
  return value;
}

function validateAdminToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isUsableAdminToken(value)) {
    // No value in the context: it is a credential.
    throw invalidFlag(
      "Invalid --admin-token. The token must be non-empty and contain no whitespace.",
      { flag: "--admin-token" },
    );
  }
  return value;
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

/**
 * Parse `schmock` command-line arguments into {@link CliOptions}.
 *
 * @throws SchmockError `INVALID_CONFIG` for a flag value the CLI refuses, a
 *   second positional argument, or `--admin-token` without `--admin`. An
 *   unknown flag throws Node's own `parseArgs` error.
 */
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
    throw invalidFlag(
      `Unexpected extra arguments: ${positionals.slice(1).join(", ")}. Pass exactly one spec path.`,
      { flag: "<spec>" },
    );
  }

  const spec = values.spec ?? positionals[0] ?? "";

  // A token alone used to be dropped silently: the admin paths fell through to
  // the mock and every authenticated call 404'd with no hint why. Implying
  // --admin instead would quietly switch an API on, so this refuses.
  if (values["admin-token"] !== undefined && !values.admin) {
    throw invalidFlag("--admin-token requires --admin.", {
      flag: "--admin-token",
    });
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

export const USAGE = `Usage: schmock <spec> [options]
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
