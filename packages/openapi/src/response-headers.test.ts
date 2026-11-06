import { schmock } from "@schmock/core";
import { MAX_STRING_LENGTH } from "@schmock/faker";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin";

/** A GET whose 200 declares one string header `X-Pad` of `minLength`. */
async function mockWithPaddedHeader(minLength: number) {
  const mock = schmock();
  mock.pipe(
    await openapi({
      spec: {
        openapi: "3.0.3",
        info: { title: "headers", version: "1.0.0" },
        paths: {
          "/x": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  headers: {
                    "X-Pad": { schema: { type: "string", minLength } },
                  },
                  content: {
                    "application/json": { schema: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    }),
  );
  return mock;
}

describe("string response header length", () => {
  it("pads a string header to its minLength", async () => {
    const mock = await mockWithPaddedHeader(3);

    const response = await mock.handle("GET", "/x");

    expect(response.status).toBe(200);
    expect(response.headers["X-Pad"]).toBe("xxx");
  });

  it("reads a negative minLength as no minimum", async () => {
    const mock = await mockWithPaddedHeader(-1);

    const response = await mock.handle("GET", "/x");

    expect(response.status).toBe(200);
    expect(response.headers["X-Pad"]).toBe("");
  });

  it("refuses a minLength past the string length limit, as a body does", async () => {
    const mock = await mockWithPaddedHeader(300_000_000);

    const response = await mock.handle("GET", "/x");

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      code: "RESOURCE_LIMIT_ERROR",
      error: expect.stringContaining(`limit=${MAX_STRING_LENGTH}`),
    });
    expect(response.headers["X-Pad"]).toBeUndefined();
  });
});
