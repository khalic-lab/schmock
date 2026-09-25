import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { SchmockError, schmock } from "@schmock/core";
import { expect, type MockInstance, vi } from "vitest";
import type { ParsedSpec } from "../parser";
import { parseSpec } from "../parser";
import { openapi } from "../plugin";
import { buildRefParserOptions } from "../ref-policy";

// `node:dns` is mocked so the default, guarded transport can be pointed at a
// name that resolves to loopback without depending on public DNS.
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

const feature = await loadFeature("../../features/review-openapi-refs.feature");
const fixturesDir = resolve(import.meta.dirname, "../__fixtures__");
const externalDir = `${fixturesDir}/external`;
const realFetch = globalThis.fetch;

type FetchStub = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Answers both the injected transport and global fetch, so HEAD sees it too. */
function installFetch(stub: FetchStub): FetchStub {
  vi.spyOn(globalThis, "fetch").mockImplementation(stub);
  return stub;
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

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpRead(policy: Parameters<typeof buildRefParserOptions>[0]) {
  const http = buildRefParserOptions(policy).resolve.http;
  if (typeof http !== "object") throw new Error("expected an http resolver");
  return http.read;
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => {
    dnsOverride.answer = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  Scenario(
    "An http $ref whose hostname resolves to a loopback address is refused",
    ({ Given, And, When, Then }) => {
      let server: Server;
      let port = 0;
      const hits: string[] = [];
      let failure: unknown;

      Given(
        "an internal service listening on the loopback interface",
        async () => {
          server = createServer((request, response) => {
            hits.push(String(request.url));
            response.end(JSON.stringify({ S: { enum: ["INTERNAL-ONLY"] } }));
          });
          await new Promise<void>((done) =>
            server.listen(0, "127.0.0.1", done),
          );
          const address = server.address();
          if (address === null || typeof address === "string") {
            throw new Error("expected a TCP address");
          }
          port = address.port;
        },
      );

      And(
        "DNS resolves {string} to the loopback interface",
        (_, hostname: string) => {
          dnsOverride.answer = (name) =>
            name === hostname ? [{ address: "127.0.0.1", family: 4 }] : [];
          // What an unguarded fetch does with such a name: connect to loopback.
          installFetch((input, init) => {
            const url = new URL(String(input));
            if (url.hostname === hostname) url.hostname = "127.0.0.1";
            return realFetch(url, init);
          });
        },
      );

      When(
        "I parse a spec whose schema is an http reference to {string} with any public host allowed",
        async (_, hostname: string) => {
          failure = await failureOf(
            parseSpec(
              specWithResponseSchema({
                $ref: `http://${hostname}:${port}/s.json#/S`,
              }),
              { refs: { external: true, allowHttp: true, allowedHosts: [] } },
            ),
          );
        },
      );

      Then(
        "parsing fails naming a loopback, link-local or private address",
        () => {
          expect(messageOf(failure)).toMatch(/loopback, link-local or private/);
        },
      );

      And("the internal service received no request", async () => {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        expect(hits).toEqual([]);
      });
    },
  );

  Scenario(
    "A remote document cannot pull in a local file",
    ({ Given, And, When, Then }) => {
      let dir: string;
      let stub: FetchStub;
      let failure: unknown;

      Given("a local file holding a secret", () => {
        dir = mkdtempSync(join(tmpdir(), "schmock-review-feature-"));
        writeFileSync(
          join(dir, "secret.json"),
          JSON.stringify({ type: "string", enum: ["LOCAL-SECRET-42"] }),
        );
      });

      And(
        "an allow-listed remote document that references the secret by file URL",
        () => {
          const remote = {
            Token: { $ref: `file://${join(dir, "secret.json")}` },
          };
          stub = installFetch(
            async () => new Response(JSON.stringify(remote), { status: 200 }),
          );
        },
      );

      When(
        "I parse a local spec that references the remote document",
        async () => {
          const specPath = join(dir, "spec.json");
          writeFileSync(
            specPath,
            JSON.stringify(
              specWithResponseSchema({
                $ref: "https://schemas.example.test/common.json#/Token",
              }),
            ),
          );
          failure = await failureOf(
            parseSpec(specPath, {
              refs: {
                external: true,
                allowHttp: true,
                allowedHosts: ["schemas.example.test"],
              },
              fetchRef: stub,
            }),
          );
        },
      );

      Then("parsing fails with code {string}", (_, code: string) => {
        expect(failure).toBeInstanceOf(SchmockError);
        expect(failure instanceof SchmockError ? failure.code : "").toBe(code);
      });

      And("the error does not contain the secret", () => {
        expect(messageOf(failure)).not.toContain("LOCAL-SECRET-42");
        rmSync(dir, { recursive: true, force: true });
      });
    },
  );

  Scenario(
    "A redirect to a file URL is refused",
    ({ Given, When, Then, And }) => {
      const requested: string[] = [];
      let failure: unknown;

      Given("an allow-listed host that redirects to a file URL", () => {
        installFetch(async (input) => {
          requested.push(String(input));
          if (String(input).startsWith("https://")) {
            return new Response(null, {
              status: 302,
              headers: { location: "file:///etc/hosts" },
            });
          }
          return new Response('{"leaked":true}', { status: 200 });
        });
      });

      When(
        "I read an http reference from that host with one redirect allowed",
        async () => {
          const read = httpRead({
            external: true,
            allowHttp: true,
            allowedHosts: ["schemas.example.test"],
            redirects: 1,
          });
          failure = await failureOf(
            read({ url: "https://schemas.example.test/moved.json" }),
          );
        },
      );

      Then("the read fails because the redirect target is not http(s)", () => {
        expect(messageOf(failure)).toMatch(
          /redirect to file:\/\/\/etc\/hosts blocked/,
        );
      });

      And("only the original URL was requested", () => {
        expect(requested).toEqual(["https://schemas.example.test/moved.json"]);
      });
    },
  );

  Scenario(
    "An oversized streamed $ref body stops at the byte limit",
    ({ Given, When, Then, And }) => {
      let pulled = 0;
      let failure: unknown;

      Given(
        "an allow-listed host that streams a large body without a Content-Length",
        () => {
          const chunk = new Uint8Array(512).fill(0x20);
          installFetch(async () => {
            const body = new ReadableStream<Uint8Array>({
              pull(controller) {
                pulled += chunk.byteLength;
                if (pulled > 20_000_000) controller.close();
                else controller.enqueue(chunk);
              },
            });
            return new Response(body, { status: 200 });
          });
        },
      );

      When(
        "I read an http reference from that host with a {int} byte limit",
        async (_, maxBytes: number) => {
          const read = httpRead({
            external: true,
            allowHttp: true,
            allowedHosts: ["schemas.example.test"],
            maxBytes,
          });
          failure = await failureOf(
            read({ url: "https://schemas.example.test/huge.json" }),
          );
        },
      );

      Then(
        "the read fails naming the {int} byte limit",
        (_, maxBytes: number) => {
          expect(messageOf(failure)).toContain(
            `above the ${maxBytes} byte limit`,
          );
        },
      );

      And(
        "the host was asked for little more than {int} bytes",
        (_, maxBytes: number) => {
          expect(pulled).toBeLessThan(maxBytes * 4);
        },
      );
    },
  );

  Scenario(
    "A timed-out http $ref names the timeout",
    ({ Given, When, Then }) => {
      let stub: FetchStub;
      let failure: unknown;

      Given("an allow-listed host that never answers", () => {
        stub = installFetch(
          (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(init.signal?.reason),
              );
            }),
        );
      });

      When(
        "I parse a spec referencing that host with a {int} ms timeout",
        async (_, timeoutMs: number) => {
          failure = await failureOf(
            parseSpec(
              specWithResponseSchema({
                $ref: "https://schemas.example.test/slow.json#/A",
              }),
              {
                refs: {
                  external: true,
                  allowHttp: true,
                  allowedHosts: ["schemas.example.test"],
                  timeoutMs,
                },
                fetchRef: stub,
              },
            ),
          );
        },
      );

      Then(
        "parsing fails with a message naming a {int}ms timeout",
        (_, timeoutMs: number) => {
          expect(messageOf(failure)).toContain(
            `timed out after ${timeoutMs}ms`,
          );
        },
      );
    },
  );

  Scenario(
    "A spec file loads when a DOM window global is present",
    ({ Given, When, Then, And }) => {
      let fetchSpy: MockInstance<typeof globalThis.fetch>;
      let parsed: ParsedSpec;

      Given(
        "a DOM-like window global pointing at {string}",
        (_, href: string) => {
          vi.stubGlobal("window", { location: { href } });
          fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockRejectedValue(new Error("network access is not allowed here"));
        },
      );

      When(
        "I parse the external fixture spec by path with external references enabled",
        async () => {
          parsed = await parseSpec(`${externalDir}/spec.json`, {
            refs: { external: true },
          });
        },
      );

      Then("the referenced schema is inlined", () => {
        expect(parsed.paths[0].responses.get(200)?.schema).toMatchObject({
          type: "object",
          properties: { label: { type: "string" } },
        });
      });

      And("no network request was attempted", () => {
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "OpenAPI 3.1 $ref siblings add to the target schema",
    ({ Given, When, Then, And }) => {
      let spec: object;
      let mock: Schmock.CallableMockInstance;

      Given(
        "an OpenAPI 3.1 spec whose request body extends a base schema with $ref siblings",
        () => {
          spec = {
            openapi: "3.1.0",
            info: { title: "Siblings", version: "1.0.0" },
            paths: {
              "/things": {
                post: {
                  requestBody: {
                    required: true,
                    content: {
                      "application/json": {
                        schema: {
                          $ref: "#/components/schemas/Base",
                          properties: { extra: { type: "string" } },
                          required: ["extra"],
                        },
                      },
                    },
                  },
                  responses: { "201": { description: "created" } },
                },
              },
            },
            components: {
              schemas: {
                Base: {
                  type: "object",
                  required: ["id", "name"],
                  properties: {
                    id: { type: "integer" },
                    name: { type: "string" },
                  },
                },
              },
            },
          };
        },
      );

      When("I create an openapi plugin from the spec", async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec, validateRequests: true }));
      });

      Then(
        "a POST missing the base schema's required fields is rejected with 400",
        async () => {
          const response = await mock.handle("POST", "/things", {
            body: { extra: "x" },
            headers: { "content-type": "application/json" },
          });
          expect(response.status).toBe(400);
        },
      );

      And("a POST carrying every required field is accepted", async () => {
        const response = await mock.handle("POST", "/things", {
          body: { id: 1, name: "n", extra: "x" },
          headers: { "content-type": "application/json" },
        });
        expect(response.status).toBe(201);
      });
    },
  );

  Scenario(
    "A $ref sibling wins regardless of document order",
    ({ Given, When, Then }) => {
      let spec: object;
      let parsed: ParsedSpec;

      Given(
        "a spec where a bare reference to {string} comes before a reference to {string} with maxLength {int}",
        (_, bareName: string, extendedName: string, maxLength: number) => {
          spec = {
            ...specWithResponseSchema({ $ref: "#/components/schemas/Obj" }),
            components: {
              schemas: {
                [bareName]: { type: "string", maxLength: 50 },
                Obj: {
                  type: "object",
                  properties: {
                    a: { $ref: `#/components/schemas/${bareName}` },
                    b: {
                      $ref: `#/components/schemas/${extendedName}`,
                      maxLength,
                    },
                  },
                },
              },
            },
          };
        },
      );

      When("I parse the spec", async () => {
        parsed = await parseSpec(spec);
      });

      Then(
        "the property with the sibling has maxLength {int}",
        (_, maxLength: number) => {
          expect(
            parsed.paths[0].responses.get(200)?.schema?.properties?.b,
          ).toMatchObject({ maxLength });
        },
      );
    },
  );

  Scenario(
    "A ring of $refs fails with a coded error",
    ({ Given, When, Then }) => {
      let spec: object;
      let failure: unknown;

      Given(
        "a spec whose schemas {string} and {string} only reference each other",
        (_, first: string, second: string) => {
          spec = {
            ...specWithResponseSchema({
              $ref: `#/components/schemas/${first}`,
            }),
            components: {
              schemas: {
                [first]: { $ref: `#/components/schemas/${second}` },
                [second]: { $ref: `#/components/schemas/${first}` },
              },
            },
          };
        },
      );

      When("I parse the spec expecting a failure", async () => {
        failure = await failureOf(parseSpec(spec));
      });

      Then("parsing fails with code {string}", (_, code: string) => {
        expect(failure instanceof SchmockError ? failure.code : failure).toBe(
          code,
        );
      });
    },
  );

  Scenario(
    "$ref-shaped content inside an example is kept as data",
    ({ Given, When, Then }) => {
      let spec: object;
      let parsed: ParsedSpec;

      Given("a spec whose response example is a $ref to another host", () => {
        spec = specWithResponseSchema({
          type: "object",
          example: { $ref: "https://json-schema.org/draft/2020-12/schema" },
        });
      });

      When("I parse the spec", async () => {
        parsed = await parseSpec(spec);
      });

      Then("the example is not treated as a reference", () => {
        // A composite `example` is dropped by the normalizer (only scalar
        // examples become `default`), so the observable is that the $ref
        // inside it was neither blocked nor resolved nor rewritten.
        const schema = parsed.paths[0].responses.get(200)?.schema;
        expect(schema).toMatchObject({ type: "object" });
        expect(schema).not.toHaveProperty("$ref");
        expect(schema).not.toHaveProperty("allOf");
      });
    },
  );

  Scenario(
    "An OpenAPI 3.2 spec loads the same with or without a $ref",
    ({ Given, When, Then }) => {
      let spec: object;
      let parsed: ParsedSpec;

      Given(
        "an OpenAPI {string} spec whose response schema is an internal reference",
        (_, version: string) => {
          spec = {
            ...specWithResponseSchema(
              { $ref: "#/components/schemas/Thing" },
              version,
            ),
            components: {
              schemas: { Thing: { type: "string", minLength: 2 } },
            },
          };
        },
      );

      When("I parse the spec", async () => {
        parsed = await parseSpec(spec);
      });

      Then("the response schema is the referenced component", () => {
        expect(parsed.paths[0].responses.get(200)?.schema).toMatchObject({
          type: "string",
          minLength: 2,
        });
      });
    },
  );
});
