import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { collectBody } from "./http-helpers.js";

function bodyStream(body: Buffer): PassThrough {
  const stream = new PassThrough();
  stream.end(body);
  return stream;
}

describe("collectBody size limits", () => {
  it("accepts a body exactly at the configured limit", async () => {
    const body = Buffer.from("12345");
    await expect(collectBody(bodyStream(body), {}, body.length)).resolves.toBe(
      "12345",
    );
  });

  it("accepts and parses JSON below the configured limit", async () => {
    const body = Buffer.from('{"ok":true}');
    await expect(
      collectBody(
        bodyStream(body),
        { "content-type": "application/json" },
        body.length + 1,
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects a body above the configured limit with status 413", async () => {
    const body = Buffer.from("123456");
    await expect(
      collectBody(bodyStream(body), {}, body.length - 1),
    ).rejects.toMatchObject({
      message: "Request body too large",
      status: 413,
    });
  });
});
