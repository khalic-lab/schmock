import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { CliServer } from "../cli";
import { createCliServer } from "../cli";

const feature = await loadFeature("../../features/watch-mode.feature");

function makeSpec(paths: Record<string, unknown>): string {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Test", version: "1.0.0" },
    paths,
  });
}

function initialPaths(): Record<string, unknown> {
  return {
    "/items": {
      get: { responses: { "200": { description: "OK" } } },
    },
  };
}

/**
 * A single TCP connection that outlives one request/response pair.
 *
 * The reload is only observably socket-preserving from a connection opened
 * *before* it: `fetch` would open a fresh one and pass even under the old
 * unbind/rebind reload.
 */
interface KeepAliveClient {
  request(path: string): Promise<number>;
  close(): void;
}

function openKeepAliveClient(
  hostname: string,
  port: number,
): Promise<KeepAliveClient> {
  return new Promise((resolveClient, rejectClient) => {
    const socket = connect(port, hostname);
    let buffer = "";
    let dropped = false;
    let pending:
      | { resolve: (status: number) => void; reject: (error: Error) => void }
      | undefined;

    const fail = (error: Error): void => {
      const waiting = pending;
      pending = undefined;
      if (waiting) waiting.reject(error);
      else rejectClient(error);
    };

    const drain = (): void => {
      if (!pending) return;
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const head = buffer.slice(0, headerEnd);
      const [statusLine = "", ...headerLines] = head.split("\r\n");
      const headers = new Map<string, string>();
      for (const line of headerLines) {
        const separator = line.indexOf(":");
        if (separator === -1) continue;
        headers.set(
          line.slice(0, separator).toLowerCase(),
          line.slice(separator + 1).trim(),
        );
      }

      const rest = buffer.slice(headerEnd + 4);
      let consumed: number;
      if (headers.get("transfer-encoding")?.includes("chunked")) {
        const terminator = rest.indexOf("0\r\n\r\n");
        if (terminator === -1) return;
        consumed = terminator + 5;
      } else {
        const declared = Number(headers.get("content-length") ?? "0");
        if (rest.length < declared) return;
        consumed = declared;
      }

      buffer = rest.slice(consumed);
      const waiting = pending;
      pending = undefined;
      waiting.resolve(Number(statusLine.split(" ")[1]));
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      drain();
    });
    socket.on("error", fail);
    socket.on("close", () => {
      // Recorded rather than ignored: a reload that churned connections would
      // otherwise surface as a request that simply never answers.
      dropped = true;
      fail(new Error("The kept-alive connection was dropped by the server"));
    });
    socket.on("connect", () => {
      resolveClient({
        request(path: string): Promise<number> {
          return new Promise<number>((resolveStatus, rejectStatus) => {
            if (dropped) {
              rejectStatus(
                new Error(
                  "The kept-alive connection was dropped by the server",
                ),
              );
              return;
            }
            if (pending) {
              rejectStatus(new Error("A request is already in flight"));
              return;
            }
            pending = { resolve: resolveStatus, reject: rejectStatus };
            socket.write(
              `GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: keep-alive\r\n\r\n`,
            );
            drain();
          });
        },
        close(): void {
          socket.destroy();
        },
      });
    });
  });
}

async function waitForRoute(
  server: CliServer,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const deadline = Date.now() + 5_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://${server.hostname}:${server.port}${path}`,
      { headers },
    );
    lastStatus = response.status;
    // Bodies must be drained or the connection stays checked out of the pool.
    await response.arrayBuffer();
    if (lastStatus === 200) return lastStatus;
    await new Promise((tick) => setTimeout(tick, 50));
  }
  throw new Error(
    `Timed out waiting for ${path} to become available (last status ${lastStatus})`,
  );
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let tempDir: string | undefined;
  let specPath = "";
  let server: CliServer | undefined;
  let keepAlive: KeepAliveClient | undefined;
  let originalPort = 0;
  let originalAdminToken: string | undefined;

  AfterEachScenario(async () => {
    keepAlive?.close();
    keepAlive = undefined;

    // `close()` owns the watcher and any reload still in flight, so nothing may
    // touch the temp directory after it resolves.
    await server?.close();
    server = undefined;
    originalAdminToken = undefined;

    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function requireServer(): CliServer {
    if (!server) throw new Error("Expected a running CLI server");
    return server;
  }

  function createTempSpec(): void {
    tempDir = mkdtempSync(join(tmpdir(), "schmock-watch-"));
    specPath = join(tempDir, "spec.json");
    writeFileSync(specPath, makeSpec(initialPaths()));
  }

  async function startWatchedServer(admin = false): Promise<void> {
    server = await createCliServer({
      spec: specPath,
      port: 0,
      watch: true,
      admin,
      shutdownGraceMs: 100,
    });
    originalPort = server.port;
    originalAdminToken = server.adminToken;
    // `fs.watch` needs one full event-loop turn before it observes anything:
    // measured on macOS/node 26, a write made in the same tick (or after only
    // microtasks) is missed, while one made after a `setImmediate` is seen.
    // Nothing a human editor could hit — but a test writes that fast.
    await new Promise((armed) => setTimeout(armed, 25));
  }

  function addUsersRoute(): void {
    writeFileSync(
      specPath,
      makeSpec({
        ...initialPaths(),
        "/users": {
          get: { responses: { "200": { description: "OK" } } },
        },
      }),
    );
  }

  Scenario(
    "Watching enabled through createCliServer reloads on a spec change",
    ({ Given, And, When, Then }) => {
      Given("a temp spec file with one route", () => {
        createTempSpec();
      });

      And("a CLI server is started with file watching", async () => {
        await startWatchedServer();
      });

      When("the spec file is updated to include a new route", () => {
        addUsersRoute();
      });

      Then(
        "the new route responds successfully on the original port",
        async () => {
          expect(await waitForRoute(requireServer(), "/users")).toBe(200);
          expect(requireServer().port).toBe(originalPort);
          expect(requireServer().server.listening).toBe(true);
        },
      );
    },
  );

  Scenario(
    "A reload keeps the listening socket bound",
    ({ Given, And, When, Then }) => {
      Given("a temp spec file with one route", () => {
        createTempSpec();
      });

      And("a CLI server is started with file watching", async () => {
        await startWatchedServer();
      });

      And("a client keeps a connection open to the CLI server", async () => {
        const current = requireServer();
        keepAlive = await openKeepAliveClient(current.hostname, current.port);
        expect(await keepAlive.request("/items")).toBe(200);
      });

      When("the spec file is updated to include a new route", () => {
        addUsersRoute();
      });

      Then(
        "the new route responds successfully on the original port",
        async () => {
          expect(await waitForRoute(requireServer(), "/users")).toBe(200);
          expect(requireServer().port).toBe(originalPort);
        },
      );

      // Reused immediately: Node's default keepAliveTimeout is 5s, and the poll
      // above has already spent part of it.
      And(
        "the connection opened before the reload still serves requests",
        async () => {
          if (!keepAlive) throw new Error("Expected a kept-alive connection");
          expect(await keepAlive.request("/users")).toBe(200);
        },
      );
    },
  );

  Scenario(
    "Invalid spec changes keep the current server online",
    ({ Given, And, When, Then }) => {
      Given("a temp spec file with one route", () => {
        createTempSpec();
      });

      And("a CLI server is started with file watching", async () => {
        await startWatchedServer();
      });

      When("the spec file is changed to invalid JSON", () => {
        writeFileSync(specPath, "{");
      });

      Then(
        "the original route remains available after the failed reload",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 800));
          const current = requireServer();
          expect(current.port).toBe(originalPort);
          expect(current.server.listening).toBe(true);
          const response = await fetch(
            `http://${current.hostname}:${current.port}/items`,
          );
          expect(response.status).toBe(200);
        },
      );
    },
  );

  Scenario(
    "An atomic editor save still triggers a reload",
    ({ Given, And, When, Then }) => {
      Given("a temp spec file with one route", () => {
        createTempSpec();
      });

      And("a CLI server is started with file watching", async () => {
        await startWatchedServer();
      });

      When(
        "the spec file is replaced by an atomic save adding a new route",
        () => {
          // What vim, JetBrains and VS Code actually do: write a sibling file
          // and rename it over the target. The spec keeps its path but gets a
          // new inode, so a watch bound to the old inode goes deaf.
          const staging = `${specPath}.tmp`;
          writeFileSync(
            staging,
            makeSpec({
              ...initialPaths(),
              "/users": {
                get: { responses: { "200": { description: "OK" } } },
              },
            }),
          );
          renameSync(staging, specPath);
        },
      );

      Then(
        "the new route responds successfully on the original port",
        async () => {
          expect(await waitForRoute(requireServer(), "/users")).toBe(200);
          expect(requireServer().port).toBe(originalPort);
        },
      );

      // The assertion that fails hardest against an inode watch: the atomic
      // rename may still be reported, but every later edit is silent.
      And("a later in-place edit still triggers a reload", async () => {
        writeFileSync(
          specPath,
          makeSpec({
            ...initialPaths(),
            "/users": {
              get: { responses: { "200": { description: "OK" } } },
            },
            "/orders": {
              get: { responses: { "200": { description: "OK" } } },
            },
          }),
        );
        expect(await waitForRoute(requireServer(), "/orders")).toBe(200);
      });
    },
  );

  Scenario(
    "The admin token survives a reload",
    ({ Given, And, When, Then }) => {
      Given("a temp spec file with one route", () => {
        createTempSpec();
      });

      And(
        "a CLI server is started with file watching and the admin API",
        async () => {
          await startWatchedServer(true);
          expect(originalAdminToken).toEqual(expect.any(String));
        },
      );

      When("the spec file is updated to include a new route", () => {
        addUsersRoute();
      });

      Then(
        "the new route responds successfully on the original port",
        async () => {
          expect(await waitForRoute(requireServer(), "/users")).toBe(200);
          expect(requireServer().port).toBe(originalPort);
        },
      );

      And(
        "the admin API still accepts the token issued at startup",
        async () => {
          const current = requireServer();
          expect(current.adminToken).toBe(originalAdminToken);
          const response = await fetch(
            `http://${current.hostname}:${current.port}/schmock-admin/state`,
            {
              headers: { authorization: `Bearer ${originalAdminToken ?? ""}` },
            },
          );
          expect(response.status).toBe(200);
        },
      );
    },
  );
});
