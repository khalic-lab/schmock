import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  collectBody,
  HttpIngressError,
  writeSchmockResponse,
} from "./http-helpers.js";

class BodyEmitter extends EventEmitter {
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function bodyStream(body: Buffer): PassThrough {
  const stream = new PassThrough();
  stream.end(body);
  return stream;
}

describe("HttpIngressError", () => {
  it("carries an HTTP status and machine-readable code", () => {
    const error = new HttpIngressError(
      413,
      "PAYLOAD_TOO_LARGE",
      "Request body too large",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "HttpIngressError",
      message: "Request body too large",
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
  });
});

describe("collectBody", () => {
  describe("size limits", () => {
    it("accepts a body exactly at the configured limit", async () => {
      const body = Buffer.from("12345");
      await expect(
        collectBody(
          bodyStream(body),
          { "content-length": String(body.length) },
          body.length,
        ),
      ).resolves.toBe("12345");
    });

    it("prechecks an oversized decimal Content-Length", async () => {
      const request = new BodyEmitter();

      await expect(
        collectBody(request, { "content-length": "6" }, 5),
      ).rejects.toMatchObject({
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body too large",
      });
      expect(request.destroyed).toBe(false);
    });

    it.each([
      "6bytes",
      "+6",
      "6.0",
      "1e1",
      "",
    ])("does not trust an invalid decimal Content-Length of %j", async (contentLength) => {
      const body = Buffer.from("12345");
      await expect(
        collectBody(
          bodyStream(body),
          { "content-length": contentLength },
          body.length,
        ),
      ).resolves.toBe("12345");
    });

    it("enforces observed bytes when Content-Length understates the body", async () => {
      const body = Buffer.from("123456");
      await expect(
        collectBody(
          bodyStream(body),
          { "content-length": "1" },
          body.length - 1,
        ),
      ).rejects.toMatchObject({
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
      });
    });

    it("settles once without destroying the request after observed overflow", async () => {
      const request = new BodyEmitter();
      const result = collectBody(request, {}, 5);

      request.emit("data", Buffer.from("123456"));
      request.emit("data", Buffer.from("later data must be ignored"));
      request.emit("error", new Error("late stream error"));
      request.emit("end");

      await expect(result).rejects.toMatchObject({
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body too large",
      });
      expect(request.destroyed).toBe(false);
    });
  });

  describe("stream termination", () => {
    it.each([
      "aborted",
      "close",
    ])("rejects when the request emits %s before end", async (event) => {
      const request = new BodyEmitter();
      const pending = collectBody(request, {});

      request.emit(event);
      request.emit("end");

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });
  });

  describe("JSON media types", () => {
    it("returns undefined for an empty body", async () => {
      await expect(
        collectBody(
          bodyStream(Buffer.alloc(0)),
          { "content-type": "application/json" },
          0,
        ),
      ).resolves.toBeUndefined();
    });

    it("normalizes the application/json base media type", async () => {
      const body = Buffer.from('{"ok":true}');
      await expect(
        collectBody(
          bodyStream(body),
          { "content-type": "Application/JSON; Charset=UTF-8" },
          body.length,
        ),
      ).resolves.toEqual({ ok: true });
    });

    it("recognizes structured JSON suffix media types", async () => {
      const body = Buffer.from('{"title":"invalid"}');
      await expect(
        collectBody(
          bodyStream(body),
          { "content-type": "Application/Problem+JSON; Charset=UTF-8" },
          body.length,
        ),
      ).resolves.toEqual({ title: "invalid" });
    });

    it.each([
      "text/json",
      "application/notjson",
      "application/json-seq",
    ])("does not parse the non-JSON media type %s", async (contentType) => {
      const body = Buffer.from('{"raw":true}');
      await expect(
        collectBody(
          bodyStream(body),
          { "content-type": contentType },
          body.length,
        ),
      ).resolves.toBe('{"raw":true}');
    });

    it("rejects malformed non-empty JSON with a structured error", async () => {
      const body = Buffer.from('{"broken":');
      await expect(
        collectBody(
          bodyStream(body),
          { "content-type": "application/json" },
          body.length,
        ),
      ).rejects.toMatchObject({
        status: 400,
        code: "MALFORMED_JSON",
      });
    });
  });
});

describe("writeSchmockResponse", () => {
  it("merges extra headers case-insensitively", () => {
    let writtenHeaders: Record<string, string> | undefined;
    const responseWriter = {
      writeHead(_status: number, headers: Record<string, string>) {
        writtenHeaders = headers;
        return this;
      },
      end() {
        return this;
      },
    };

    writeSchmockResponse(
      responseWriter,
      {
        status: 200,
        body: "ok",
        headers: { "Access-Control-Allow-Origin": "route" },
      },
      { "access-control-allow-origin": "*" },
    );

    expect(writtenHeaders).toEqual({ "access-control-allow-origin": "*" });
  });
});
