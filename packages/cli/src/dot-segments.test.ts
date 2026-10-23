import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { schmock } from "@schmock/core";
import { openapi } from "@schmock/openapi";
import { afterEach, describe, expect, it } from "vitest";
import { createCliServer } from "./cli";

const PETSTORE_SPEC = resolve(
  __dirname,
  "../../openapi/src/__fixtures__/petstore-openapi3.json",
);

/** GET a raw request target, which no client-side URL parsing rewrites. */
function rawGet(
  port: number,
  target: string,
): Promise<{ status: number; body: string }> {
  return new Promise((done, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: target, method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => done({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// Decision 57: every server transport resolves a request target's dot
// segments before routing, as mock.listen() does, so `/a/../pets` and its
// percent-encoded spelling reach `/pets`.
describe("the CLI server resolves dot segments before routing (decision 57)", () => {
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function cliPort(): Promise<number> {
    const server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      shutdownGraceMs: 100,
    });
    closers.push(() => server.close());
    return server.port;
  }

  async function listenPort(): Promise<number> {
    const mock = schmock();
    mock.pipe(await openapi({ spec: PETSTORE_SPEC }));
    const { port } = await mock.listen(0, "127.0.0.1");
    closers.push(() => mock.close());
    return port;
  }

  it.each([
    ["/a/../pets", "/pets"],
    ["/a/%2e%2e/pets", "/pets"],
    ["/a/./pets/..", "/a/"],
  ])("routes %s as %s, as mock.listen() does", async (target, resolved) => {
    const port = await cliPort();
    const viaCli = await rawGet(port, target);

    expect(viaCli).toEqual(await rawGet(port, resolved));
    expect(viaCli).toEqual(await rawGet(await listenPort(), target));
  });

  it("serves the list a dot-segment target resolves to", async () => {
    const response = await rawGet(await cliPort(), "/a/%2E%2E/pets");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(expect.any(Array));
  });
});
