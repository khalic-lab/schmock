import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { collectBody, writeSchmockResponse } from "./http-helpers.js";

function bodyStream(body: Buffer): PassThrough {
  const stream = new PassThrough();
  stream.end(body);
  return stream;
}

function collect(body: string | Buffer, contentType?: string) {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  const headers: Record<string, string> =
    contentType === undefined ? {} : { "content-type": contentType };
  return collectBody(bodyStream(bytes), headers, bytes.length);
}

describe("collectBody media types (interceptor parity)", () => {
  it("parses urlencoded bodies with a charset parameter, last duplicate wins", async () => {
    await expect(
      collect(
        "name=Rex&tag=a&tag=b&note=a+b%21",
        "Application/X-WWW-Form-Urlencoded; charset=UTF-8",
      ),
    ).resolves.toEqual({ name: "Rex", tag: "b", note: "a b!" });
  });

  it("decodes text/* bodies as UTF-8 strings", async () => {
    await expect(collect("café", "text/csv")).resolves.toBe("café");
  });

  it("returns an ArrayBuffer that owns exactly the request bytes", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd8, 0x00]);
    const body = await collect(bytes, "image/png");
    if (!(body instanceof ArrayBuffer)) throw new Error("expected bytes");
    expect(body.byteLength).toBe(7);
    expect(Buffer.from(body).equals(bytes)).toBe(true);
  });

  it("still returns undefined for an empty body of any type", async () => {
    await expect(collect("", "multipart/form-data; boundary=x")).resolves.toBe(
      undefined,
    );
    await expect(collect("")).resolves.toBeUndefined();
  });

  it("parses multipart bodies into FormData even when close follows end", async () => {
    const boundary = "schmock-boundary";
    const wire = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="name"',
      "",
      "Rex",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    // PassThrough emits `close` right after `end`; the async multipart parse
    // must not be pre-empted by the abort listener.
    const body = await collect(
      wire,
      `multipart/form-data; boundary=${boundary}`,
    );
    if (!(body instanceof FormData)) throw new Error("expected FormData");
    expect(body.get("name")).toBe("Rex");
  });

  it("rejects a malformed multipart body with a structured 400", async () => {
    await expect(
      collect("not multipart at all", "multipart/form-data; boundary=missing"),
    ).rejects.toMatchObject({ status: 400, code: "MALFORMED_MULTIPART" });
  });

  it("rejects JSON nested past 256 levels and accepts exactly 256", async () => {
    const nested = (depth: number) => "[".repeat(depth) + "]".repeat(depth);
    const deepObject = `${'{"a":'.repeat(257)}1${"}".repeat(257)}`;

    await expect(
      collect(nested(257), "application/json"),
    ).rejects.toMatchObject({ status: 400, code: "JSON_TOO_DEEP" });
    await expect(collect(deepObject, "application/json")).rejects.toMatchObject(
      { status: 400, code: "JSON_TOO_DEEP" },
    );
    await expect(
      collect(nested(256), "application/json"),
    ).resolves.toBeInstanceOf(Array);
  });
});

describe("writeSchmockResponse framing", () => {
  function captureHead(response: Schmock.Response) {
    let written: Record<string, string> = {};
    const res = {
      writeHead(_status: number, headers: Record<string, string>) {
        written = headers;
        return this;
      },
      end() {
        return this;
      },
    };
    writeSchmockResponse(res, response);
    return written;
  }

  it("declares the serialized byte length", () => {
    expect(
      captureHead({ status: 200, body: "héllo", headers: {} })[
        "content-length"
      ],
    ).toBe("6");
    expect(
      captureHead({ status: 200, body: { a: 1 }, headers: {} })[
        "content-length"
      ],
    ).toBe(String(JSON.stringify({ a: 1 }).length));
  });

  it("leaves bodiless responses without a content-length", () => {
    expect(
      captureHead({ status: 204, body: undefined, headers: {} }),
    ).not.toHaveProperty("content-length");
  });
});

describe("workspace packaging", () => {
  const packagesDir = resolve(import.meta.dirname, "..", "..");
  const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf8"));
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  it.each(packageDirs)(
    "@schmock/%s gives every exports entry a default condition",
    (dir) => {
      const manifest = readJson(join(packagesDir, dir, "package.json"));
      if (!isRecord(manifest) || !isRecord(manifest.exports)) return;
      for (const [subpath, target] of Object.entries(manifest.exports)) {
        if (!isRecord(target)) continue;
        expect(Object.keys(target), subpath).toContain("default");
        expect(target.default, subpath).toBe(target.import);
      }
    },
  );

  it.each(packageDirs)("@schmock/%s ships no declaration maps", (dir) => {
    const tsconfig = readJson(join(packagesDir, dir, "tsconfig.json"));
    if (!isRecord(tsconfig) || !isRecord(tsconfig.compilerOptions)) return;
    expect(tsconfig.compilerOptions.declarationMap).not.toBe(true);
  });

  it.each(packageDirs)("@schmock/%s lints its whole src tree", (dir) => {
    const manifest = readJson(join(packagesDir, dir, "package.json"));
    if (!isRecord(manifest) || !isRecord(manifest.scripts)) return;
    for (const name of ["lint", "lint:fix"]) {
      expect(String(manifest.scripts[name]), name).not.toContain("src/*.ts");
    }
  });
});
