import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";

const feature = await loadFeature(
  "../../features/review-core-http-adapters.feature",
);

const NOTHING_RECORDED = Symbol("nothing recorded");

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    hex.split(" ").map((pair) => Number.parseInt(pair, 16)),
  );
}

function expectArrayBufferHolding(value: unknown, hex: string): void {
  if (!(value instanceof ArrayBuffer)) {
    throw new Error(`Expected an ArrayBuffer body, received ${typeof value}`);
  }
  expect(new Uint8Array(value)).toEqual(hexBytes(hex));
}

function nestedArrays(depth: number): string {
  return `${"[".repeat(depth)}${"]".repeat(depth)}`;
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance | undefined;
  let port = 0;
  let recorded: unknown = NOTHING_RECORDED;
  let response: Response | undefined;

  AfterEachScenario(() => {
    mock?.close();
    mock = undefined;
    recorded = NOTHING_RECORDED;
    response = undefined;
  });

  async function listenRecordingEcho(): Promise<void> {
    mock = schmock();
    mock("POST /echo", ({ body }) => {
      recorded = body;
      return { ok: true };
    });
    port = (await mock.listen(0)).port;
  }

  async function post(
    body: BodyInit,
    headers: Record<string, string> = {},
  ): Promise<void> {
    response = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: "POST",
      headers,
      body,
    });
  }

  Scenario(
    "A urlencoded form body reaches the handler as an object",
    ({ Given, When, Then }) => {
      Given("a listening mock that records the body of POST /echo", () =>
        listenRecordingEcho(),
      );

      When(
        'I POST "name=Rex&age=3" to /echo as "application/x-www-form-urlencoded;charset=UTF-8"',
        () =>
          post("name=Rex&age=3", {
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          }),
      );

      Then(
        'the recorded body should be the object {"name":"Rex","age":"3"}',
        () => {
          expect(response?.status).toBe(200);
          expect(recorded).toEqual({ name: "Rex", age: "3" });
        },
      );
    },
  );

  Scenario(
    "A text body reaches the handler as a string",
    ({ Given, When, Then }) => {
      Given("a listening mock that records the body of POST /echo", () =>
        listenRecordingEcho(),
      );

      When('I POST "plain words" to /echo as "text/plain; charset=utf-8"', () =>
        post("plain words", { "content-type": "text/plain; charset=utf-8" }),
      );

      Then('the recorded body should be the string "plain words"', () => {
        expect(recorded).toBe("plain words");
      });
    },
  );

  Scenario(
    "A binary upload reaches the handler as intact bytes",
    ({ Given, When, Then }) => {
      Given("a listening mock that records the body of POST /echo", () =>
        listenRecordingEcho(),
      );

      When(
        'I POST the bytes 89 50 4e 47 ff d8 00 to /echo as "application/octet-stream"',
        () =>
          post(hexBytes("89 50 4e 47 ff d8 00"), {
            "content-type": "application/octet-stream",
          }),
      );

      Then(
        "the recorded body should be an ArrayBuffer holding 89 50 4e 47 ff d8 00",
        () => {
          expectArrayBufferHolding(recorded, "89 50 4e 47 ff d8 00");
        },
      );
    },
  );

  Scenario(
    "A body sent without a content type reaches the handler as bytes",
    ({ Given, When, Then }) => {
      Given("a listening mock that records the body of POST /echo", () =>
        listenRecordingEcho(),
      );

      When("I POST the bytes 7b 7d to /echo without a content type", () =>
        // A typed-array body gives fetch nothing to infer a type from, so the
        // request goes out with no content-type header at all.
        post(hexBytes("7b 7d")),
      );

      Then("the recorded body should be an ArrayBuffer holding 7b 7d", () => {
        expectArrayBufferHolding(recorded, "7b 7d");
      });
    },
  );

  Scenario(
    "A multipart upload reaches the handler as form data",
    ({ Given, When, Then }) => {
      Given("a listening mock that records the body of POST /echo", () =>
        listenRecordingEcho(),
      );

      When(
        'I POST a multipart form with field "name" set to "Rex" and a 3-byte file "photo" to /echo',
        () => {
          const form = new FormData();
          form.set("name", "Rex");
          form.set(
            "photo",
            new Blob([hexBytes("ff d8 00")], { type: "image/jpeg" }),
            "photo.jpg",
          );
          return post(form);
        },
      );

      Then(
        'the recorded body should be form data whose "name" is "Rex" and whose "photo" file holds 3 bytes',
        async () => {
          if (!(recorded instanceof FormData)) {
            throw new Error(
              `Expected a FormData body, received ${typeof recorded}`,
            );
          }
          expect(recorded.get("name")).toBe("Rex");
          const photo = recorded.get("photo");
          if (!(photo instanceof Blob)) {
            throw new Error("Expected the photo part to be a file");
          }
          const bytes = new Uint8Array(await photo.arrayBuffer());
          expect(bytes).toEqual(hexBytes("ff d8 00"));
        },
      );
    },
  );

  Scenario(
    "A deeply nested JSON body is rejected before any handler runs",
    ({ Given, When, Then, And }) => {
      Given("a listening mock that records the body of POST /echo", () =>
        listenRecordingEcho(),
      );

      When("I POST a JSON body nested 300 levels deep to /echo", () =>
        post(nestedArrays(300), { "content-type": "application/json" }),
      );

      Then(
        'the HTTP status should be 400 with error code "JSON_TOO_DEEP"',
        async () => {
          expect(response?.status).toBe(400);
          await expect(response?.json()).resolves.toMatchObject({
            code: "JSON_TOO_DEEP",
          });
        },
      );

      And("no body should have been recorded", () => {
        expect(recorded).toBe(NOTHING_RECORDED);
      });
    },
  );

  Scenario(
    "A JSON body nested exactly at the depth limit is accepted",
    ({ Given, When, Then }) => {
      Given("a listening mock that records the body of POST /echo", () =>
        listenRecordingEcho(),
      );

      When("I POST a JSON body nested 256 levels deep to /echo", () =>
        post(nestedArrays(256), { "content-type": "application/json" }),
      );

      Then("the HTTP status should be 200", () => {
        expect(response?.status).toBe(200);
        expect(Array.isArray(recorded)).toBe(true);
      });
    },
  );

  Scenario(
    "A fixed-size response carries a Content-Length header",
    ({ Given, When, Then }) => {
      let rawHeaders: IncomingHttpHeaders = {};

      Given('a listening mock whose GET /text returns "hello"', async () => {
        mock = schmock();
        mock("GET /text", "hello");
        port = (await mock.listen(0)).port;
      });

      When("I GET /text with a raw Node HTTP client", async () => {
        // fetch hides framing details, so read Node's own view of the headers.
        rawHeaders = await new Promise<IncomingHttpHeaders>(
          (resolve, reject) => {
            const outgoing = httpRequest(
              { host: "127.0.0.1", port, path: "/text", method: "GET" },
              (incoming) => {
                incoming.resume();
                incoming.on("end", () => resolve(incoming.headers));
              },
            );
            outgoing.on("error", reject);
            outgoing.end();
          },
        );
      });

      Then(
        'the raw response should carry content-length "5" and no transfer-encoding',
        () => {
          expect(rawHeaders["content-length"]).toBe("5");
          expect(rawHeaders["transfer-encoding"]).toBeUndefined();
        },
      );
    },
  );

  Scenario(
    "A repeated query key resolves to its last value",
    ({ Given, When, Then }) => {
      Given("a listening mock that echoes the query of GET /echo", async () => {
        mock = schmock();
        mock("GET /echo", ({ query }) => query);
        port = (await mock.listen(0)).port;
      });

      When('I GET "/echo?tag=a&tag=b"', async () => {
        response = await fetch(`http://127.0.0.1:${port}/echo?tag=a&tag=b`);
      });

      Then('the echoed query should be {"tag":"b"}', async () => {
        await expect(response?.json()).resolves.toEqual({ tag: "b" });
      });
    },
  );
});
