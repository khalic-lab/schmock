import { describe, expect, it } from "vitest";
import { isBinaryBody } from "./binary.js";
import { schmock } from "./index.js";
import { parseResponse } from "./response-parser.js";

function binaryBytes(value: unknown): number[] {
  if (value instanceof ArrayBuffer) {
    return [...new Uint8Array(value)];
  }
  if (ArrayBuffer.isView(value)) {
    return [
      ...new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    ];
  }
  throw new Error("Expected a binary response body");
}

describe("isBinaryBody", () => {
  it("recognizes browser binary values without a Node Buffer global", () => {
    expect(isBinaryBody(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(isBinaryBody(new ArrayBuffer(3))).toBe(true);
    expect(isBinaryBody(new DataView(new SharedArrayBuffer(3)))).toBe(true);
    expect(isBinaryBody({ 0: 1, length: 1 })).toBe(false);
  });
});

describe("parseResponse binary handling", () => {
  it("stringifies text objects when Buffer is not available", () => {
    const originalBuffer = globalThis.Buffer;
    Reflect.deleteProperty(globalThis, "Buffer");

    try {
      const response = parseResponse(
        { message: "browser" },
        { contentType: "text/plain" },
      );

      expect(response.body).toBe('{"message":"browser"}');
    } finally {
      globalThis.Buffer = originalBuffer;
    }
  });

  it("detects binary returned by a dynamic generator", async () => {
    const mock = schmock();
    mock("GET /dynamic-binary", () => new Uint8Array([1, 2, 3]));

    const response = await mock.handle("GET", "/dynamic-binary");

    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(binaryBytes(response.body)).toEqual([1, 2, 3]);
  });

  it("detects binary in a status tuple", async () => {
    const mock = schmock();
    const bytes = new Uint8Array([4, 5, 6]);
    mock(
      "GET /tuple-binary",
      () => [206, new DataView(bytes.buffer)] satisfies [number, unknown],
    );

    const response = await mock.handle("GET", "/tuple-binary");

    expect(response.status).toBe(206);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(binaryBytes(response.body)).toEqual([4, 5, 6]);
  });

  it("detects binary in a response object", () => {
    const response = parseResponse(
      { status: 206, body: new Uint8Array([7, 8]), headers: {} },
      {},
    );

    expect(response.status).toBe(206);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(binaryBytes(response.body)).toEqual([7, 8]);
  });

  it("preserves an explicit binary content type", async () => {
    const mock = schmock();
    mock("GET /image", () => new Uint8Array([137, 80, 78, 71]), {
      contentType: "image/png",
    });

    const response = await mock.handle("GET", "/image");

    expect(response.headers["content-type"]).toBe("image/png");
    expect(binaryBytes(response.body)).toEqual([137, 80, 78, 71]);
  });

  it("preserves a tuple content-type header without adding a duplicate", () => {
    const response = parseResponse(
      [
        200,
        new Uint8Array([1]),
        { "Content-Type": "application/custom-binary" },
      ],
      { contentType: "application/json" },
    );

    expect(response.headers).toEqual({
      "Content-Type": "application/custom-binary",
    });
    expect(binaryBytes(response.body)).toEqual([1]);
  });
});

describe("browser runtime compatibility", () => {
  it("defines and serves object routes when Buffer is not available", async () => {
    const originalBuffer = globalThis.Buffer;
    Reflect.deleteProperty(globalThis, "Buffer");

    try {
      const mock = schmock();
      mock("GET /browser", { runtime: "browser" });

      const response = await mock.handle("GET", "/browser");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ runtime: "browser" });
      expect(response.headers["content-type"]).toBe("application/json");
    } finally {
      globalThis.Buffer = originalBuffer;
    }
  });
});
