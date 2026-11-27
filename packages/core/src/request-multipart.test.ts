import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { serveNodeRequest } from "./http-helpers.js";
import { schmock } from "./index.js";
import { routeRelayedRequest } from "./interceptor.js";

const BOUNDARY = "batch-boundary";

/**
 * A multipart/related body of a JSON part and a binary part, the shape of a
 * metadata-plus-file upload. The binary part holds bytes that are not valid
 * UTF-8, so a body that round-trips through text would not match.
 */
function relatedBody(): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(
      `--${BOUNDARY}\r\n` +
        "Content-Type: application/json\r\n\r\n" +
        '{"name":"photo.jpg"}\r\n' +
        `--${BOUNDARY}\r\n` +
        "Content-Type: image/jpeg\r\n\r\n",
    ),
    new Uint8Array([0xff, 0xd8, 0x00, 0x80]),
    encoder.encode(`\r\n--${BOUNDARY}--\r\n`),
  ];
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

const RELATED_TYPE = `multipart/related; type="application/json"; boundary=${BOUNDARY}`;
const MIXED_TYPE = `multipart/mixed; boundary=${BOUNDARY}`;
/** A media type that only begins with multipart/form-data. */
const FORM_DATA_LOOKALIKE_TYPE = `multipart/form-data-x; boundary=${BOUNDARY}`;

/** A one-field multipart/form-data body, written out by hand. */
function nameFormText(): string {
  return [
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="name"',
    "",
    "Rex",
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
}

/** What a route saw of one request: its body and its content type. */
interface SeenBody {
  body: unknown;
  contentType: string | undefined;
}

function recordingMock(): {
  mock: Schmock.CallableMockInstance;
  seen: SeenBody[];
} {
  const seen: SeenBody[] = [];
  const mock = schmock();
  mock("POST /upload", (ctx) => {
    seen.push({ body: ctx.body, contentType: ctx.headers["content-type"] });
    return { ok: true };
  });
  return { mock, seen };
}

/** The body a route saw, as bytes, failing when it is not an ArrayBuffer. */
function bytesOf(seen: SeenBody | undefined): Uint8Array {
  if (!(seen?.body instanceof ArrayBuffer)) {
    throw new Error(`Expected an ArrayBuffer body, received ${seen?.body}`);
  }
  return new Uint8Array(seen.body);
}

function formOf(seen: SeenBody | undefined): FormData {
  if (!(seen?.body instanceof FormData)) {
    throw new Error(`Expected a FormData body, received ${seen?.body}`);
  }
  return seen.body;
}

function nameForm(): FormData {
  const form = new FormData();
  form.set("name", "Rex");
  return form;
}

describe("multipart bodies other than multipart/form-data", () => {
  describe("mock.intercept()", () => {
    let handle: Schmock.InterceptHandle | undefined;

    afterEach(() => {
      handle?.restore();
      handle = undefined;
    });

    it.each([
      ["multipart/related", RELATED_TYPE],
      ["multipart/mixed", MIXED_TYPE],
      ["multipart/form-data-x", FORM_DATA_LOOKALIKE_TYPE],
    ])(
      "hands a %s body to the route as the bytes sent",
      async (_, contentType) => {
        const { mock, seen } = recordingMock();
        handle = mock.intercept({ passthrough: false });

        const response = await fetch("http://localhost/upload", {
          method: "POST",
          headers: { "content-type": contentType },
          body: relatedBody(),
        });

        expect(response.status).toBe(200);
        expect(bytesOf(seen[0])).toEqual(relatedBody());
        expect(seen[0]?.contentType).toBe(contentType);
      },
    );

    it("still hands a multipart/form-data body to the route as FormData", async () => {
      const { mock, seen } = recordingMock();
      handle = mock.intercept({ passthrough: false });

      await fetch("http://localhost/upload", {
        method: "POST",
        body: nameForm(),
      });

      expect(formOf(seen[0]).get("name")).toBe("Rex");
    });

    it("hands a multipart/form-data body labelled in mixed case to the route as FormData", async () => {
      const { mock, seen } = recordingMock();
      handle = mock.intercept({ passthrough: false });

      const response = await fetch("http://localhost/upload", {
        method: "POST",
        headers: {
          "content-type": `Multipart/Form-Data; boundary=${BOUNDARY}`,
        },
        body: nameFormText(),
      });

      expect(response.status).toBe(200);
      expect(formOf(seen[0]).get("name")).toBe("Rex");
    });

    it("hands a multipart/related body the DevTools relay brings back as the bytes sent", async () => {
      const { mock, seen } = recordingMock();
      handle = mock.intercept({ passthrough: false });

      const response = await routeRelayedRequest(
        new Request("http://localhost/upload", {
          method: "POST",
          headers: { "content-type": RELATED_TYPE },
          body: relatedBody(),
        }),
      );

      expect(response?.status).toBe(200);
      expect(bytesOf(seen[0])).toEqual(relatedBody());
    });

    it("still hands a relayed multipart/form-data body to the route as FormData", async () => {
      const { mock, seen } = recordingMock();
      handle = mock.intercept({ passthrough: false });

      await routeRelayedRequest(
        new Request("http://localhost/upload", {
          method: "POST",
          body: nameForm(),
        }),
      );

      expect(formOf(seen[0]).get("name")).toBe("Rex");
    });
  });

  describe("mock.listen()", () => {
    let mock: Schmock.CallableMockInstance | undefined;

    afterEach(() => {
      mock?.close();
      mock = undefined;
    });

    it("hands a multipart/related body to the route as the bytes sent", async () => {
      const recording = recordingMock();
      mock = recording.mock;
      const { port } = await mock.listen(0);

      const response = await fetch(`http://127.0.0.1:${port}/upload`, {
        method: "POST",
        headers: { "content-type": RELATED_TYPE },
        body: relatedBody(),
      });

      expect(response.status).toBe(200);
      expect(bytesOf(recording.seen[0])).toEqual(relatedBody());
      expect(recording.seen[0]?.contentType).toBe(RELATED_TYPE);
    });
  });

  describe("serveNodeRequest() (the CLI's ingress)", () => {
    let server: Server | undefined;

    afterEach(async () => {
      await new Promise(
        (resolve) => server?.close(resolve) ?? resolve(undefined),
      );
      server = undefined;
    });

    async function serve(mock: Schmock.CallableMockInstance): Promise<number> {
      server = createServer((req, res) => {
        void serveNodeRequest(req, res, { handle: mock.handle.bind(mock) });
      });
      await new Promise<void>((resolve) =>
        server?.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a TCP address");
      }
      return address.port;
    }

    it("hands a multipart/mixed body to the route as the bytes sent", async () => {
      const { mock, seen } = recordingMock();
      const port = await serve(mock);

      const response = await fetch(`http://127.0.0.1:${port}/upload`, {
        method: "POST",
        headers: { "content-type": MIXED_TYPE },
        body: relatedBody(),
      });

      expect(response.status).toBe(200);
      expect(bytesOf(seen[0])).toEqual(relatedBody());
      expect(seen[0]?.contentType).toBe(MIXED_TYPE);
    });

    it("still hands a multipart/form-data body to the route as FormData", async () => {
      const { mock, seen } = recordingMock();
      const port = await serve(mock);

      await fetch(`http://127.0.0.1:${port}/upload`, {
        method: "POST",
        body: nameForm(),
      });

      expect(formOf(seen[0]).get("name")).toBe("Rex");
    });
  });
});
