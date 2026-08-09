import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer as createPortReservation } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import type { CliServer } from "../cli";
import { createCliServer, run } from "../cli";

const feature = await loadFeature("../../features/cli-standalone.feature");
const fixturesDir = resolve(
  import.meta.dirname,
  "../../../openapi/src/__fixtures__",
);

interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendRawHttpRequest(
  port: number,
  request: string,
  keepWritableOpen = false,
): Promise<RawHttpResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = connect(port, "127.0.0.1");
    let rawResponse = "";

    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => {
      socket.destroy(new Error("Timed out waiting for raw CLI response"));
    });
    socket.on("connect", () => {
      if (keepWritableOpen) socket.write(request);
      else socket.end(request);
    });
    socket.on("data", (chunk: string) => {
      rawResponse += chunk;
    });
    socket.on("error", rejectResponse);
    socket.on("close", () => {
      const responseSeparator = rawResponse.indexOf("\r\n\r\n");
      const head =
        responseSeparator === -1
          ? rawResponse
          : rawResponse.slice(0, responseSeparator);
      const body =
        responseSeparator === -1
          ? ""
          : rawResponse.slice(responseSeparator + 4);
      const [statusLine = "", ...headerLines] = head.split("\r\n");
      const status = Number(statusLine.split(" ")[1]);
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const headerSeparator = line.indexOf(":");
        if (headerSeparator === -1) continue;
        headers[line.slice(0, headerSeparator).toLowerCase()] = line
          .slice(headerSeparator + 1)
          .trim();
      }
      resolveResponse({ status, headers, body });
    });
  });
}

/**
 * Send a request head and keep uploading body bytes until the server's
 * response arrives. Exercises the overflow-during-upload path: the 413 must
 * survive while the client is still transmitting, which a headers-only
 * request cannot verify.
 */
function sendRawHttpRequestWhileUploading(
  port: number,
  requestHead: string,
  totalBodyBytes: number,
): Promise<RawHttpResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = connect(port, "127.0.0.1");
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let written = 0;
    let rawResponse = "";
    let responseComplete = false;

    const pump = (): void => {
      while (!responseComplete && written < totalBodyBytes) {
        const next = chunk.subarray(
          0,
          Math.min(chunk.length, totalBodyBytes - written),
        );
        written += next.length;
        if (!socket.write(next)) {
          socket.once("drain", pump);
          return;
        }
      }
    };

    socket.setTimeout(10_000, () => {
      socket.destroy(new Error("Timed out waiting for raw CLI response"));
    });
    socket.on("connect", () => {
      socket.write(requestHead);
      pump();
    });
    socket.on("data", (data: Buffer) => {
      rawResponse += data.toString("utf8");
      if (!responseComplete && rawResponse.includes("\r\n\r\n")) {
        responseComplete = true;
        socket.end();
      }
    });
    socket.on("error", rejectResponse);
    socket.on("close", () => {
      const responseSeparator = rawResponse.indexOf("\r\n\r\n");
      const head =
        responseSeparator === -1
          ? rawResponse
          : rawResponse.slice(0, responseSeparator);
      const body =
        responseSeparator === -1
          ? ""
          : rawResponse.slice(responseSeparator + 4);
      const [statusLine = "", ...headerLines] = head.split("\r\n");
      const status = Number(statusLine.split(" ")[1]);
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const headerSeparator = line.indexOf(":");
        if (headerSeparator === -1) continue;
        headers[line.slice(0, headerSeparator).toLowerCase()] = line
          .slice(headerSeparator + 1)
          .trim();
      }
      resolveResponse({ status, headers, body });
    });
  });
}

function reserveAvailablePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const reservation = createPortReservation();
    reservation.once("error", rejectPort);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      if (address === null || typeof address === "string") {
        reservation.close();
        rejectPort(new Error("Expected an IP port reservation"));
        return;
      }
      const port = address.port;
      reservation.close(() => resolvePort(port));
    });
  });
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let cliServer: CliServer | undefined;
  let httpResponse: Response | undefined;
  let specPath = "";
  let seedPath = "";
  let thrownError: Error | undefined;
  let rawHttpResponse: RawHttpResponse | undefined;
  let chosenPort = 0;
  let cliExitCode: number | undefined;
  let cliErrorOutput = "";
  const tempDirs = new Set<string>();

  function requireServer(): CliServer {
    if (!cliServer) throw new Error("Expected a running CLI server");
    return cliServer;
  }

  function requireHttpResponse(): Response {
    if (!httpResponse) throw new Error("Expected a CLI HTTP response");
    return httpResponse;
  }

  function requireRawHttpResponse(): RawHttpResponse {
    if (!rawHttpResponse) throw new Error("Expected a raw CLI HTTP response");
    return rawHttpResponse;
  }

  function requireThrownError(): Error {
    if (!thrownError) throw new Error("Expected CLI creation to reject");
    return thrownError;
  }

  function baseUrl(): string {
    const server = requireServer();
    return `http://${server.hostname}:${server.port}`;
  }

  function writeTempFile(
    directoryPrefix: string,
    filename: string,
    content: string,
  ): string {
    const directory = mkdtempSync(join(tmpdir(), directoryPrefix));
    tempDirs.add(directory);
    const path = join(directory, filename);
    writeFileSync(path, content);
    return path;
  }

  async function closeServer(): Promise<void> {
    const server = cliServer;
    cliServer = undefined;
    if (!server?.server.listening) return;

    server.server.closeAllConnections();
    await new Promise<void>((resolveClose) => {
      server.server.close(() => resolveClose());
    });
  }

  async function stopServerThroughPublicApi(): Promise<void> {
    const server = requireServer();
    if (!server.server.listening) {
      cliServer = undefined;
      return;
    }
    await new Promise<void>((resolveClose) => {
      server.server.once("close", resolveClose);
      server.close();
    });
    cliServer = undefined;
  }

  AfterEachScenario(async () => {
    await closeServer();
    for (const directory of tempDirs) {
      rmSync(directory, { recursive: true, force: true });
    }
    tempDirs.clear();
    httpResponse = undefined;
    thrownError = undefined;
    rawHttpResponse = undefined;
    chosenPort = 0;
    cliExitCode = undefined;
    cliErrorOutput = "";
  });

  Scenario("Start server from a spec file", ({ Given, When, Then, And }) => {
    Given("I have a petstore spec file", () => {
      specPath = resolve(fixturesDir, "petstore-openapi3.json");
    });

    When("I create a CLI server from the spec", async () => {
      cliServer = await createCliServer({ spec: specPath, port: 0 });
    });

    Then("the CLI server should be running", () => {
      expect(requireServer().port).toBeGreaterThan(0);
      expect(requireServer().server.listening).toBe(true);
    });

    When("I fetch {string} from the CLI server", async (_, route: string) => {
      const [, path] = route.split(" ");
      httpResponse = await fetch(`${baseUrl()}${path}`);
    });

    Then("the CLI response status should be {int}", (_, status: number) => {
      expect(requireHttpResponse().status).toBe(status);
    });

    And("the CLI response body should be an array", async () => {
      const body: unknown = await requireHttpResponse().json();
      expect(Array.isArray(body)).toBe(true);
    });

    When("I stop the CLI server", async () => {
      await stopServerThroughPublicApi();
    });
  });

  Scenario("Serve with seed data", ({ Given, When, And, Then }) => {
    Given("I have a petstore spec file", () => {
      specPath = resolve(fixturesDir, "petstore-openapi3.json");
    });

    And("I have a seed data file with pets", () => {
      seedPath = writeTempFile(
        "schmock-test-seed-",
        "seed.json",
        JSON.stringify({
          pets: [{ id: 1, name: "Buddy", tag: "dog" }],
        }),
      );
    });

    When("I create a CLI server with seed data", async () => {
      cliServer = await createCliServer({
        spec: specPath,
        port: 0,
        seed: seedPath,
      });
    });

    And("I fetch {string} from the CLI server", async (_, route: string) => {
      const [, path] = route.split(" ");
      httpResponse = await fetch(`${baseUrl()}${path}`);
    });

    Then("the CLI response status should be {int}", (_, status: number) => {
      expect(requireHttpResponse().status).toBe(status);
    });

    And("the CLI response body should contain the seeded pet", async () => {
      const body: unknown = await requireHttpResponse().json();
      if (!Array.isArray(body)) {
        throw new Error("Expected CLI response body to be an array");
      }
      expect(body.some((pet) => isRecord(pet) && pet.name === "Buddy")).toBe(
        true,
      );
    });

    When("I stop the CLI server", async () => {
      await stopServerThroughPublicApi();
    });
  });

  Scenario("Custom port", ({ Given, When, Then, And }) => {
    Given("I have a petstore spec file", () => {
      specPath = resolve(fixturesDir, "petstore-openapi3.json");
    });

    And("I reserve an available CLI port", async () => {
      chosenPort = await reserveAvailablePort();
    });

    When("I create a CLI server on the reserved port", async () => {
      cliServer = await createCliServer({ spec: specPath, port: chosenPort });
    });

    Then("the CLI server should be running on the reserved port", () => {
      expect(requireServer().port).toBe(chosenPort);
      expect(requireServer().server.listening).toBe(true);
    });

    When("I stop the CLI server", async () => {
      await stopServerThroughPublicApi();
    });
  });

  Scenario("CORS headers on responses", ({ Given, When, Then, And }) => {
    Given("I have a petstore spec file", () => {
      specPath = resolve(fixturesDir, "petstore-openapi3.json");
    });

    When("I create a CLI server with CORS enabled", async () => {
      cliServer = await createCliServer({
        spec: specPath,
        port: 0,
        cors: true,
      });
    });

    And("I fetch {string} from the CLI server", async (_, route: string) => {
      const [, path] = route.split(" ");
      httpResponse = await fetch(`${baseUrl()}${path}`);
    });

    Then("the CLI response should have CORS headers", () => {
      expect(
        requireHttpResponse().headers.get("access-control-allow-origin"),
      ).toBe("*");
    });

    When("I stop the CLI server", async () => {
      await stopServerThroughPublicApi();
    });
  });

  Scenario("CORS preflight OPTIONS request", ({ Given, When, Then, And }) => {
    Given("I have a petstore spec file", () => {
      specPath = resolve(fixturesDir, "petstore-openapi3.json");
    });

    When("I create a CLI server with CORS enabled", async () => {
      cliServer = await createCliServer({
        spec: specPath,
        port: 0,
        cors: true,
      });
    });

    And("I send an OPTIONS preflight to the CLI server", async () => {
      httpResponse = await fetch(`${baseUrl()}/pets`, { method: "OPTIONS" });
    });

    Then("the CLI response status should be {int}", (_, status: number) => {
      expect(requireHttpResponse().status).toBe(status);
    });

    And("the CLI response should have CORS headers", () => {
      expect(
        requireHttpResponse().headers.get("access-control-allow-origin"),
      ).toBe("*");
    });

    When("I stop the CLI server", async () => {
      await stopServerThroughPublicApi();
    });
  });

  Scenario("Missing spec shows usage error", ({ When, Then, And }) => {
    When("I run the CLI without a spec", async () => {
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      const stderrWrite = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk) => {
          cliErrorOutput += String(chunk);
          return true;
        });

      try {
        await run([]);
        cliExitCode = process.exitCode;
      } finally {
        stderrWrite.mockRestore();
        process.exitCode = previousExitCode;
      }
    });

    Then("the CLI process exit code should be 1", () => {
      expect(cliExitCode).toBe(1);
    });

    And(
      "the CLI error output should contain {string}",
      (_, message: string) => {
        expect(cliErrorOutput).toContain(message);
      },
    );
  });

  Scenario("Invalid spec shows error", ({ Given, When, Then }) => {
    Given("I have an invalid spec file", () => {
      specPath = writeTempFile(
        "schmock-invalid-",
        "invalid.json",
        '{ "not": "an OpenAPI document" }',
      );
    });

    When("I create a CLI server from the invalid spec", async () => {
      try {
        await createCliServer({ spec: specPath, port: 0 });
        thrownError = undefined;
      } catch (error) {
        thrownError = error instanceof Error ? error : new Error(String(error));
      }
    });

    Then("the CLI error should contain {string}", (_, message: string) => {
      expect(requireThrownError().message).toContain(message);
    });
  });

  Scenario("Reject unsupported HTTP methods", ({ Given, When, Then, And }) => {
    Given("I have a running CLI petstore server", async () => {
      specPath = resolve(fixturesDir, "petstore-openapi3.json");
      cliServer = await createCliServer({ spec: specPath, port: 0 });
    });

    When(
      "I send a raw CLI request with method {string} target {string} and host {string}",
      async (_, method: string, target: string, host: string) => {
        rawHttpResponse = await sendRawHttpRequest(
          requireServer().port,
          `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
        );
      },
    );

    Then("the raw CLI response status should be {int}", (_, status: number) => {
      expect(requireRawHttpResponse().status).toBe(status);
    });

    And("the raw CLI response should allow supported methods", () => {
      expect(requireRawHttpResponse().headers.allow).toContain("GET");
      expect(requireRawHttpResponse().headers.allow).toContain("POST");
    });

    When("I stop the CLI server", async () => {
      await stopServerThroughPublicApi();
    });
  });

  Scenario("Reject a malformed request target", ({ Given, When, Then }) => {
    Given("I have a running CLI petstore server", async () => {
      specPath = resolve(fixturesDir, "petstore-openapi3.json");
      cliServer = await createCliServer({ spec: specPath, port: 0 });
    });

    When(
      "I send a raw CLI request with method {string} target {string} and host {string}",
      async (_, method: string, target: string, host: string) => {
        rawHttpResponse = await sendRawHttpRequest(
          requireServer().port,
          `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
        );
      },
    );

    Then("the raw CLI response status should be {int}", (_, status: number) => {
      expect(requireRawHttpResponse().status).toBe(status);
    });

    When("I stop the CLI server", async () => {
      await stopServerThroughPublicApi();
    });
  });

  Scenario(
    "Reject an oversized declared request body",
    ({ Given, When, Then, And }) => {
      Given("I have a running CLI petstore server", async () => {
        specPath = resolve(fixturesDir, "petstore-openapi3.json");
        cliServer = await createCliServer({ spec: specPath, port: 0 });
      });

      When("I send a raw CLI request declaring an oversized body", async () => {
        // Transmit the declared body while waiting: the 413 must reach a
        // client that is still uploading, not only one that sent bare headers.
        rawHttpResponse = await sendRawHttpRequestWhileUploading(
          requireServer().port,
          "POST /pets HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 10485761\r\nConnection: keep-alive\r\n\r\n",
          10_485_761,
        );
      });

      Then(
        "the raw CLI response status should be {int}",
        (_, status: number) => {
          expect(requireRawHttpResponse().status).toBe(status);
        },
      );

      And("the raw CLI response should close the connection", () => {
        expect(requireRawHttpResponse().headers.connection).toBe("close");
      });

      And(
        "the CLI server should accept a valid request afterward",
        async () => {
          const response = await fetch(`${baseUrl()}/pets`);
          expect(response.status).toBe(200);
        },
      );

      When("I stop the CLI server", async () => {
        await stopServerThroughPublicApi();
      });
    },
  );

  Scenario(
    "Reject an oversized chunked request body",
    ({ Given, When, Then, And }) => {
      Given("I have a running CLI petstore server", async () => {
        specPath = resolve(fixturesDir, "petstore-openapi3.json");
        cliServer = await createCliServer({ spec: specPath, port: 0 });
      });

      When(
        "I send a raw CLI request with an oversized chunked body",
        async () => {
          const chunk = "0".repeat(1024 * 1024);
          const encodedChunks = Array.from(
            { length: 11 },
            () => `${chunk.length.toString(16)}\r\n${chunk}\r\n`,
          ).join("");
          rawHttpResponse = await sendRawHttpRequest(
            requireServer().port,
            `POST /pets HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${encodedChunks}0\r\n\r\n`,
          );
        },
      );

      Then(
        "the raw CLI response status should be {int}",
        (_, status: number) => {
          expect(requireRawHttpResponse().status).toBe(status);
        },
      );

      And(
        "the raw CLI response body should contain code {string}",
        (_, code: string) => {
          expect(requireRawHttpResponse().body).toContain(`"code":"${code}"`);
        },
      );
    },
  );

  Scenario(
    "Reject malformed JSON before OpenAPI handling",
    ({ Given, When, Then, And }) => {
      Given("I have a running CLI petstore server", async () => {
        specPath = resolve(fixturesDir, "petstore-openapi3.json");
        cliServer = await createCliServer({ spec: specPath, port: 0 });
      });

      When("I send a raw CLI request with malformed JSON", async () => {
        const body = '{"broken":';
        rawHttpResponse = await sendRawHttpRequest(
          requireServer().port,
          `POST /pets HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      });

      Then(
        "the raw CLI response status should be {int}",
        (_, status: number) => {
          expect(requireRawHttpResponse().status).toBe(status);
        },
      );

      And(
        "the raw CLI response body should contain code {string}",
        (_, code: string) => {
          expect(requireRawHttpResponse().body).toContain(`"code":"${code}"`);
        },
      );
    },
  );
});
