import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { SchmockError } from "@schmock/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { dereferenceInternal } from "./deref-internal";
import { parseSpec } from "./parser";
import {
  buildRefParserOptions,
  checkRef,
  isUnsafeHost,
  type RefPolicy,
  resolveRefPolicy,
} from "./ref-policy";

/**
 * Pins the fixes for the `openapi-refs` review findings: the SSRF host block,
 * local-file reads reached through remote documents, streamed size limits,
 * resolver diagnostics, the jsdom path bug, and the `$ref`-sibling, ring,
 * literal-position and version inconsistencies.
 */

// `node:dns` is mocked so the DEFAULT wiring of `parseSpec` — the guarded
// transport, no override — can be pointed at a name that resolves to loopback
// without depending on public DNS.
const dnsOverride = vi.hoisted(() => ({
  answer: undefined as
    | undefined
    | ((hostname: string) => Array<{ address: string; family: number }>),
}));

vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const lookup = (
    hostname: string,
    options: import("node:dns").LookupAllOptions,
  ) => {
    const answer = dnsOverride.answer;
    return answer
      ? Promise.resolve(answer(hostname))
      : actual.promises.lookup(hostname, options);
  };
  const promises = { ...actual.promises, lookup };
  return { ...actual, promises, default: { ...actual, promises } };
});

const fixturesDir = resolve(import.meta.dirname, "__fixtures__");
const externalDir = `${fixturesDir}/external`;
const realFetch = globalThis.fetch;

afterEach(() => {
  dnsOverride.answer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function codeOf(error: unknown): string | undefined {
  return error instanceof SchmockError ? error.code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function specWithResponseSchema(schema: object, version = "3.0.3") {
  return {
    openapi: version,
    info: { title: "Review", version: "1.0.0" },
    paths: {
      "/x": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema } },
            },
          },
        },
      },
    },
  };
}

function httpResolver(policy: RefPolicy, diagnostics?: Map<string, string>) {
  const http = buildRefParserOptions(policy, diagnostics).resolve?.http;
  if (typeof http !== "object" || http === null) {
    throw new Error("expected an http resolver object");
  }
  return http;
}

interface LocalServer {
  server: Server;
  port: number;
  hits: string[];
}

async function startServer(
  handler: (
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
): Promise<LocalServer> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(`${request.headers.host} ${request.url}`);
    handler(request, response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return { server, port: address.port, hits };
}

function stopServer(local: LocalServer): Promise<void> {
  local.server.closeAllConnections();
  return new Promise((done) => local.server.close(() => done()));
}

// ── #29 / #9: literal ranges the host block missed ───────────────────────────

describe("isUnsafeHost: internal ranges beyond RFC1918", () => {
  it("blocks CGNAT, benchmarking, reserved, multicast and broadcast IPv4", () => {
    for (const host of [
      "100.100.100.200", // Alibaba Cloud metadata
      "100.64.0.1",
      "100.127.255.254", // top of 100.64/10 (Tailscale tailnets live here)
      "198.18.0.1",
      "198.19.255.255",
      "192.0.0.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isUnsafeHost(host), host).toBe(true);
    }
  });

  it("classifies the IPv4 embedded in IPv6 transition forms", () => {
    for (const host of [
      "::7f00:1", // IPv4-compatible 127.0.0.1, as WHATWG spells [::127.0.0.1]
      "::ffff:0:7f00:1", // IPv4-translated 127.0.0.1
      "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
      "2002:a9fe:a9fe::", // 6to4 of 169.254.169.254
      "fec0::1", // deprecated site-local
      "ff02::1", // multicast
      "fe80::1%en0", // link-local with a zone id, as getaddrinfo can report it
    ]) {
      expect(isUnsafeHost(host), host).toBe(true);
    }
  });

  it("still allows public addresses, including their transition forms", () => {
    for (const host of [
      "8.8.8.8",
      "100.63.255.255",
      "100.128.0.1",
      "198.17.255.255",
      "198.20.0.1",
      "223.255.255.255",
      "64:ff9b::808:808", // NAT64 of 8.8.8.8: IPv6-only hosts need this
      "2002:808:808::1", // 6to4 of 8.8.8.8
      "2606:4700:4700::1111",
    ]) {
      expect(isUnsafeHost(host), host).toBe(false);
    }
  });

  it("refuses those ranges in an http $ref under the any-host policy", () => {
    const anyHost = resolveRefPolicy({ external: true, allowHttp: true });
    for (const url of [
      "http://100.100.100.200/latest/meta-data/x.json",
      "http://[64:ff9b::a9fe:a9fe]/x.json",
      "http://[::127.0.0.1]/x.json",
    ]) {
      expect(checkRef(url, anyHost).allowed, url).toBe(false);
    }
  });
});

// ── #1 / #9: the host block has to hold for NAMES, at connect time ───────────

describe("guarded http transport", () => {
  let internal: LocalServer;

  beforeAll(async () => {
    internal = await startServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          Secret: { type: "string", enum: ["LOOPBACK-SECRET"] },
        }),
      );
    });
  });

  afterAll(async () => {
    await stopServer(internal);
  });

  it("refuses an http $ref whose hostname resolves to loopback (default wiring)", async () => {
    internal.hits.length = 0;
    dnsOverride.answer = () => [{ address: "127.0.0.1", family: 4 }];
    // What the system resolver would do for a name like 127.0.0.1.nip.io: the
    // unguarded path hands the name to fetch, which connects to loopback.
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(String(input));
      url.hostname = "127.0.0.1";
      return realFetch(url, init);
    });

    const error = await failureOf(
      parseSpec(
        specWithResponseSchema({
          $ref: `http://internal.example.test:${internal.port}/s.json#/Secret`,
        }),
        { refs: { external: true, allowHttp: true } },
      ),
    );

    expect(messageOf(error)).toMatch(/loopback, link-local or private/);
    expect(messageOf(error)).not.toContain("LOOPBACK-SECRET");
    expect(internal.hits).toEqual([]);
  });

  it("refuses a name when ANY of its addresses is private", async () => {
    const { createGuardedFetch } = await import("./ref-transport");
    internal.hits.length = 0;
    const guarded = createGuardedFetch({
      resolveHost: async () => [
        { address: "93.184.215.14", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });

    await expect(
      guarded(`http://mixed.example.test:${internal.port}/s.json`, {
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toThrow(/127\.0\.0\.1.*loopback, link-local or private/);
    expect(internal.hits).toEqual([]);
  });

  it("refuses an unsafe IP literal without resolving it", async () => {
    const { createGuardedFetch } = await import("./ref-transport");
    const resolveHost = vi.fn(async () => [
      { address: "93.184.215.14", family: 4 },
    ]);
    const guarded = createGuardedFetch({ resolveHost });

    await expect(
      guarded("http://[::ffff:a9fe:a9fe]/latest/meta-data", {
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toThrow(/loopback, link-local or private/);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("connects to the address it vetted, once, and keeps the original Host", async () => {
    const { createGuardedFetch } = await import("./ref-transport");
    internal.hits.length = 0;
    const resolveHost = vi.fn(async () => [
      { address: "127.0.0.1", family: 4 },
    ]);
    // Loopback is the only address a test can listen on, so the block itself
    // is relaxed here; the pinning is what is under test.
    const guarded = createGuardedFetch({
      resolveHost,
      isBlockedAddress: () => false,
    });

    const response = await guarded(
      `http://pinned.example.test:${internal.port}/doc.json`,
      { signal: AbortSignal.timeout(2_000) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("LOOPBACK-SECRET");
    expect(resolveHost).toHaveBeenCalledTimes(1);
    expect(internal.hits).toEqual([
      `pinned.example.test:${internal.port} /doc.json`,
    ]);
  });

  it("counts decompressed bytes against maxBytes (gzip bomb)", async () => {
    const { createGuardedFetch } = await import("./ref-transport");
    // 64 MB of zeros compresses to ~64 KB: an honest Content-Length far below
    // the limit, and a body far above it once decoded.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    const gzipHost = await startServer((_request, response) => {
      response.setHeader("content-encoding", "gzip");
      response.setHeader("content-length", String(bomb.length));
      response.end(bomb);
    });
    try {
      const options = buildRefParserOptions(
        { external: true, allowHttp: true, maxBytes: 1_000_000 },
        undefined,
        createGuardedFetch({
          resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
          isBlockedAddress: () => false,
        }),
      );
      const http = options.resolve.http;
      if (typeof http !== "object") throw new Error("expected http resolver");

      await expect(
        http.read({ url: `http://bomb.example.test:${gzipHost.port}/b.json` }),
      ).rejects.toThrow(/above the 1000000 byte limit/);
    } finally {
      await stopServer(gzipHost);
    }
  });
});

// ── #8: maxBytes must bound what is pulled, not what is kept ─────────────────

describe("http $ref size limit while streaming", () => {
  it("stops reading the body shortly after maxBytes", async () => {
    const chunk = new Uint8Array(1_000).fill(0x20);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 50_000_000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(endless, { status: 200 }),
    );

    const http = httpResolver({
      external: true,
      allowHttp: true,
      allowedHosts: ["schemas.example.test"],
      maxBytes: 10_000,
    });
    await expect(
      http.read({ url: "https://schemas.example.test/big.json" }),
    ).rejects.toThrow(/above the 10000 byte limit/);
    // A few chunks of slack for the stream's own read-ahead, not 50 MB.
    expect(pulled).toBeLessThan(20_000);
  });
});

// ── #6 / #28: remote content must not reach the local filesystem ────────────

describe("http $ref redirects", () => {
  it("refuses a redirect whose target is not http(s)", async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requested.push(url);
      if (url === "https://schemas.example.test/moved.json") {
        return new Response(null, {
          status: 302,
          headers: { location: "file:///etc/passwd" },
        });
      }
      return new Response('{"leaked":true}', { status: 200 });
    });

    const http = httpResolver({
      external: true,
      allowHttp: true,
      allowedHosts: ["schemas.example.test"],
      redirects: 1,
    });
    await expect(
      http.read({ url: "https://schemas.example.test/moved.json" }),
    ).rejects.toThrow(/redirect to file:\/\/\/etc\/passwd blocked/);
    expect(requested).toEqual(["https://schemas.example.test/moved.json"]);
  });
});

describe("local files reached through a remote document", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "schmock-review-refs-"));
    mkdirSync(join(root, "api"));
    mkdirSync(join(root, "shared models"));
    writeFileSync(
      join(root, "secret.json"),
      JSON.stringify({ type: "string", enum: ["TOP-SECRET-VALUE"] }),
    );
    writeFileSync(
      join(root, "shared models", "models.json"),
      JSON.stringify({
        Pet: { type: "object", properties: { id: { type: "integer" } } },
      }),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSpec(name: string, schema: object): string {
    const path = join(root, "api", name);
    writeFileSync(path, JSON.stringify(specWithResponseSchema(schema)));
    return path;
  }

  /** Serves one remote document; the same stub also answers global fetch. */
  function serveRemote(document: object) {
    const stub = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://schemas.example.test/")) {
        return new Response(JSON.stringify(document), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(stub);
    return stub;
  }

  const refs = {
    external: true,
    allowHttp: true,
    allowedHosts: ["schemas.example.test"],
  };

  it("refuses a file: URL $ref inside a fetched document", async () => {
    const stub = serveRemote({
      Token: { $ref: `file://${join(root, "secret.json")}` },
    });
    const spec = writeSpec("nested-file.json", {
      $ref: "https://schemas.example.test/common.json#/Token",
    });

    const error = await failureOf(parseSpec(spec, { refs, fetchRef: stub }));

    expect(codeOf(error)).toBe("OPENAPI_EXTERNAL_REF_BLOCKED");
    expect(messageOf(error)).not.toContain("TOP-SECRET-VALUE");
  });

  it("refuses an opaque-scheme $ref that would reach the file resolver", async () => {
    const climb = "../".repeat(40);
    const stub = serveRemote({
      Token: { $ref: `foo:x/${climb}${join(root, "secret.json").slice(1)}` },
    });
    const spec = writeSpec("opaque-file.json", {
      $ref: "https://schemas.example.test/common.json#/Token",
    });

    const error = await failureOf(parseSpec(spec, { refs, fetchRef: stub }));

    expect(messageOf(error)).not.toContain("TOP-SECRET-VALUE");
    expect(codeOf(error)).toBe("OPENAPI_EXTERNAL_REF_BLOCKED");
  });

  it("still resolves local refs next to http refs, spaces in paths included", async () => {
    const stub = serveRemote({ Remote: { type: "string" } });
    const spec = writeSpec("mixed.json", {
      type: "object",
      properties: {
        pet: { $ref: "../shared%20models/models.json#/Pet" },
        remote: { $ref: "https://schemas.example.test/common.json#/Remote" },
      },
    });

    const parsed = await parseSpec(spec, { refs, fetchRef: stub });

    expect(parsed.paths[0].responses.get(200)?.schema).toMatchObject({
      properties: {
        pet: { type: "object", properties: { id: { type: "integer" } } },
        remote: { type: "string" },
      },
    });
  });
});

// ── #110: timeouts and network failures keep their detail ────────────────────

describe("http $ref failure diagnostics", () => {
  const policy: RefPolicy = {
    external: true,
    allowHttp: true,
    allowedHosts: ["schemas.example.test"],
    timeoutMs: 50,
  };

  it("names the timeout when the request outlives timeoutMs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const diagnostics = new Map<string, string>();

    await expect(
      httpResolver(policy, diagnostics).read({
        url: "https://schemas.example.test/slow.json",
      }),
    ).rejects.toThrow(/timed out after 50ms/);
    expect(diagnostics.get("https://schemas.example.test/slow.json")).toMatch(
      /timed out after 50ms/,
    );
  });

  it("names the network failure and its cause", async () => {
    const cause = Object.assign(
      new Error("getaddrinfo ENOTFOUND schemas.example.test"),
      { code: "ENOTFOUND" },
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", { cause }),
    );
    const diagnostics = new Map<string, string>();

    await expect(
      httpResolver(policy, diagnostics).read({
        url: "https://schemas.example.test/gone.json",
      }),
    ).rejects.toThrow(/could not be fetched: fetch failed.*ENOTFOUND/);
    expect(diagnostics.get("https://schemas.example.test/gone.json")).toMatch(
      /ENOTFOUND/,
    );
  });
});

// ── #26: path specs under a DOM global (jsdom / happy-dom test environments) ─

describe("file-path specs when a DOM window global exists", () => {
  it("reads the spec and its relative refs from disk, not window.location", async () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:3000/" } });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network access is not allowed here"));

    const byRelativePath = await parseSpec(
      relative(process.cwd(), `${fixturesDir}/petstore-openapi3.json`),
    );
    const withExternalRef = await parseSpec(`${externalDir}/spec.json`, {
      refs: { external: true },
    });

    expect(byRelativePath.paths.length).toBeGreaterThan(0);
    expect(withExternalRef.paths[0].responses.get(200)?.schema).toMatchObject({
      type: "object",
      properties: { label: { type: "string" } },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── #58: OAS 3.1 `$ref` siblings are a conjunction, not an override ──────────

describe("OpenAPI 3.1 $ref siblings", () => {
  function spec31(schema: object) {
    return {
      ...specWithResponseSchema(schema, "3.1.0"),
      components: {
        schemas: {
          Base: {
            type: "object",
            required: ["id", "name"],
            properties: { id: { type: "integer" }, name: { type: "string" } },
          },
        },
      },
    };
  }

  it("keeps the target's properties and required alongside the siblings", async () => {
    const parsed = await parseSpec(
      spec31({
        $ref: "#/components/schemas/Base",
        properties: { extra: { type: "string" } },
        required: ["extra"],
      }),
    );
    const schema = parsed.paths[0].responses.get(200)?.schema;

    const serialized = JSON.stringify(schema);
    for (const name of ["id", "name", "extra"]) {
      expect(serialized, name).toContain(`"${name}"`);
    }
    expect(serialized).toMatch(/"required":\["id","name"\]/);
    expect(serialized).toMatch(/"required":\["extra"\]/);
  });

  it("still lets annotation siblings override, as a Reference Object may", async () => {
    const parsed = await parseSpec(
      spec31({ $ref: "#/components/schemas/Base", description: "overridden" }),
    );

    expect(parsed.paths[0].responses.get(200)?.schema).toMatchObject({
      description: "overridden",
      required: ["id", "name"],
    });
  });
});

// ── #60: sibling overrides must not depend on document order ─────────────────

describe("$ref siblings and the dereference cache", () => {
  function specWithOrder(bareFirst: boolean) {
    const bare = { $ref: "#/components/schemas/Name" };
    const extended = { $ref: "#/components/schemas/Name", maxLength: 3 };
    return {
      ...specWithResponseSchema({ $ref: "#/components/schemas/Obj" }),
      components: {
        schemas: {
          Name: { type: "string", maxLength: 50 },
          Obj: {
            type: "object",
            properties: bareFirst
              ? { a: bare, b: extended }
              : { b: extended, a: bare },
          },
        },
      },
    };
  }

  it("lets the sibling win on the Node resolver in either order", async () => {
    for (const bareFirst of [true, false]) {
      const parsed = await parseSpec(specWithOrder(bareFirst));
      const schema = parsed.paths[0].responses.get(200)?.schema;
      expect(schema?.properties?.b, `bareFirst=${bareFirst}`).toMatchObject({
        maxLength: 3,
      });
    }
  });

  it("lets the sibling win on the browser resolver in either order", () => {
    for (const bareFirst of [true, false]) {
      const document = dereferenceInternal(specWithOrder(bareFirst));
      expect(
        document.components.schemas.Obj.properties.b,
        `bareFirst=${bareFirst}`,
      ).toMatchObject({ maxLength: 3 });
    }
  });
});

// ── #61: a ring of refs that never reaches a value ───────────────────────────

describe("$ref rings", () => {
  function ringSpec() {
    return {
      openapi: "3.0.3",
      info: { title: "Ring", version: "1.0.0" },
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/A" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          A: { $ref: "#/components/schemas/B" },
          B: { $ref: "#/components/schemas/A" },
        },
      },
    };
  }

  it("raises OPENAPI_INVALID_REF in the browser resolver instead of overflowing", () => {
    let thrown: unknown;
    try {
      dereferenceInternal(ringSpec());
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe("OPENAPI_INVALID_REF");
  });

  it("raises OPENAPI_INVALID_REF on the Node path instead of leaving the $ref", async () => {
    expect(codeOf(await failureOf(parseSpec(ringSpec())))).toBe(
      "OPENAPI_INVALID_REF",
    );
  });

  it("still accepts a direct self-reference", async () => {
    const spec = ringSpec();
    spec.components.schemas.A = { $ref: "#/components/schemas/A" };
    spec.components.schemas.B = { $ref: "#/components/schemas/A" };
    await expect(parseSpec(spec)).resolves.toBeDefined();
  });
});

// ── #63: `$ref`-shaped data in examples and vendor extensions ────────────────

// The normalizer drops a composite `example` (only scalar examples are promoted
// to `default`), so the observable is that parsing neither treats the nested
// `$ref` as a reference (no OPENAPI_EXTERNAL_REF_BLOCKED / OPENAPI_INVALID_REF)
// nor rewrites the schema node that carried it.
describe("$ref-shaped data in literal positions", () => {
  it("keeps an example that is itself a $ref to another host", async () => {
    const parsed = await parseSpec(
      specWithResponseSchema({
        type: "object",
        example: { $ref: "https://json-schema.org/draft/2020-12/schema" },
      }),
    );
    const schema = parsed.paths[0].responses.get(200)?.schema;
    expect(schema).toMatchObject({ type: "object" });
    expect(schema).not.toHaveProperty("$ref");
    expect(schema).not.toHaveProperty("allOf");
  });

  it("does not rewrite an internal-looking $ref nested in an example", async () => {
    const spec = {
      ...specWithResponseSchema({
        type: "object",
        example: { pointer: { $ref: "#/components/schemas/A" } },
      }),
      components: { schemas: { A: { type: "string" } } },
    };
    const parsed = await parseSpec(spec);
    const schema = parsed.paths[0].responses.get(200)?.schema;
    expect(schema).toMatchObject({ type: "object" });
    expect(schema).not.toHaveProperty("$ref");
    expect(schema).not.toHaveProperty("allOf");
  });

  it("restores a hidden $ref without touching an own __proto__ key", async () => {
    const { hideLiteralRefs } = await import("./spec-refs");
    const example = JSON.parse(
      '{"$ref":"https://x.test/a.json","__proto__":{"polluted":true}}',
    );
    const document = {
      openapi: "3.0.3",
      components: { schemas: { A: { type: "object", example } } },
    };

    const hidden = hideLiteralRefs(document);
    expect(Object.keys(example)).not.toContain("$ref");
    hidden.restore();

    expect(Object.keys(example)).toEqual(["$ref", "__proto__"]);
    expect(Object.getPrototypeOf(example)).toBe(Object.prototype);
  });

  it("ignores $refs inside nested x-* extensions", async () => {
    const spec = specWithResponseSchema({ type: "string" });
    Object.assign(spec.paths["/x"].get, {
      "x-codeSamples": [{ lang: "js", source: { $ref: "./samples/x.js" } }],
    });
    await expect(parseSpec(spec)).resolves.toBeDefined();
  });

  it("still dereferences names that merely look like literal keywords", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Names", version: "1.0.0" },
      paths: {
        "/x": {
          get: {
            responses: {
              default: {
                description: "fallback",
                headers: {
                  "x-rate-limit": {
                    schema: { $ref: "#/components/schemas/N" },
                  },
                },
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        example: { $ref: "#/components/schemas/N" },
                        default: { $ref: "#/components/schemas/N" },
                      },
                    },
                    examples: { one: { $ref: "#/components/examples/One" } },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: { N: { type: "integer" } },
        examples: { One: { value: { example: 1, default: 2 } } },
      },
    };
    const parsed = await parseSpec(spec);
    const entry = parsed.paths[0].responses.get("default");
    expect(entry?.schema).toMatchObject({
      properties: {
        example: { type: "integer" },
        default: { type: "integer" },
      },
    });
    expect(JSON.stringify(entry)).not.toContain("$ref");
  });
});

// ── #59: version acceptance must not depend on `$ref` presence ───────────────

describe("OpenAPI versions swagger-parser does not know", () => {
  function versioned(
    field: "openapi" | "swagger",
    version: string,
    withRef: boolean,
  ) {
    const base = specWithResponseSchema(
      withRef ? { $ref: "#/components/schemas/A" } : { type: "string" },
    );
    const { openapi: _dropped, ...rest } = base;
    return {
      [field]: version,
      ...rest,
      components: { schemas: { A: { type: "string" } } },
    };
  }

  it("loads a 3.2.0 object spec the same with or without a $ref", async () => {
    for (const withRef of [false, true]) {
      const parsed = await parseSpec(versioned("openapi", "3.2.0", withRef));
      expect(
        parsed.paths[0].responses.get(200)?.schema,
        `withRef=${withRef}`,
      ).toMatchObject({ type: "string" });
    }
  });

  it("rejects an unsupported version with a coded error in strict mode", async () => {
    const error = await failureOf(
      parseSpec(versioned("openapi", "3.2.0", false), { strict: true }),
    );
    expect(codeOf(error)).toBe("OPENAPI_INVALID_SPEC");
    expect(messageOf(error)).toMatch(/3\.2\.0/);
  });

  it("rejects an unsupported version in a spec FILE with a coded error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schmock-review-version-"));
    try {
      const path = join(dir, "spec.json");
      writeFileSync(path, JSON.stringify(versioned("openapi", "3.2.0", false)));
      const error = await failureOf(parseSpec(path));
      expect(codeOf(error)).toBe("OPENAPI_INVALID_SPEC");
      expect(messageOf(error)).toMatch(/3\.2\.0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
