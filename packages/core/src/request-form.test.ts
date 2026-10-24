import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { serveNodeRequest } from "./http-helpers.js";
import { schmock } from "./index.js";
import { routeRelayedRequest } from "./interceptor.js";
import { decodeFormBody } from "./request-body.js";

const FORM_TYPE = "application/x-www-form-urlencoded";

/** What a route saw of one request: its body and every value of `tag`. */
interface SeenForm {
  body: unknown;
  tags: string[] | undefined;
  hasForm: boolean;
}

function recordingMock(): {
  mock: Schmock.CallableMockInstance;
  seen: SeenForm[];
} {
  const seen: SeenForm[] = [];
  const mock = schmock();
  mock("POST /tags", (ctx) => {
    seen.push({
      body: ctx.body,
      tags: ctx.form?.getAll("tag"),
      hasForm: "form" in ctx,
    });
    return { ok: true };
  });
  return { mock, seen };
}

describe("urlencoded request forms", () => {
  describe("decodeFormBody", () => {
    it("keeps every field as sent beside the last-wins record", () => {
      const { value, form } = decodeFormBody("tag=a&name=Rex&tag=b");
      expect(value).toEqual({ tag: "b", name: "Rex" });
      expect([...form]).toEqual([
        ["tag", "a"],
        ["name", "Rex"],
        ["tag", "b"],
      ]);
    });

    it("keeps a field named __proto__ as an own entry of the record", () => {
      const { value } = decodeFormBody("__proto__=x");
      expect(Object.hasOwn(value, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    });
  });

  describe("handle() request options", () => {
    it("hands RequestOptions.form to the generator and every plugin hook", async () => {
      const form = new URLSearchParams("tag=a&tag=b");
      const pluginForms: unknown[] = [];
      const mock = schmock();
      mock("POST /tags", ({ form: seen }) => seen?.getAll("tag") ?? []);
      mock.pipe({
        name: "form-reader",
        beforeRequest(context) {
          pluginForms.push(context.form);
        },
        process(context, result) {
          pluginForms.push(context.form);
          return { context, response: result };
        },
      });

      const response = await mock.handle("POST", "/tags", {
        body: { tag: "b" },
        form,
      });

      expect(response.body).toEqual(["a", "b"]);
      expect(pluginForms).toEqual([form, form]);
    });

    it("leaves form off both contexts when the caller passes none", async () => {
      const { mock, seen } = recordingMock();
      const pluginKeys: boolean[] = [];
      mock.pipe({
        name: "form-probe",
        beforeRequest(context) {
          pluginKeys.push("form" in context);
        },
        process: (context, response) => ({ context, response }),
      });

      await mock.handle("POST", "/tags", { body: { tag: "b" } });

      expect(seen).toEqual([
        { body: { tag: "b" }, tags: undefined, hasForm: false },
      ]);
      expect(pluginKeys).toEqual([false]);
    });
  });

  describe("mock.intercept()", () => {
    let handle: Schmock.InterceptHandle | undefined;

    afterEach(() => {
      handle?.restore();
      handle = undefined;
    });

    it("passes every value of a repeated name beside the last-wins body", async () => {
      const { mock, seen } = recordingMock();
      handle = mock.intercept({ passthrough: false });

      await fetch("http://localhost/tags", {
        method: "POST",
        body: new URLSearchParams("tag=a&tag=b"),
      });

      expect(seen).toEqual([
        { body: { tag: "b" }, tags: ["a", "b"], hasForm: true },
      ]);
    });

    it("passes no form for a body that is not urlencoded", async () => {
      const { mock, seen } = recordingMock();
      handle = mock.intercept({ passthrough: false });

      await fetch("http://localhost/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag: ["a", "b"] }),
      });

      expect(seen).toEqual([
        { body: { tag: ["a", "b"] }, tags: undefined, hasForm: false },
      ]);
    });

    it("keeps the form when a beforeRequest hook keeps the body", async () => {
      const { mock, seen } = recordingMock();
      handle = mock.intercept({
        passthrough: false,
        beforeRequest: (request) => ({
          ...request,
          headers: { ...request.headers, "x-hooked": "1" },
        }),
      });

      await fetch("http://localhost/tags", {
        method: "POST",
        body: new URLSearchParams("tag=a&tag=b"),
      });

      expect(seen[0]?.tags).toEqual(["a", "b"]);
    });

    it("drops the form when a beforeRequest hook replaces the body", async () => {
      const { mock, seen } = recordingMock();
      handle = mock.intercept({
        passthrough: false,
        beforeRequest: (request) => ({ ...request, body: { tag: "c" } }),
      });

      await fetch("http://localhost/tags", {
        method: "POST",
        body: new URLSearchParams("tag=a&tag=b"),
      });

      expect(seen).toEqual([
        { body: { tag: "c" }, tags: undefined, hasForm: false },
      ]);
    });

    it("passes the form for a request the DevTools relay brings back", async () => {
      const { mock, seen } = recordingMock();
      handle = mock.intercept({ passthrough: false });

      const response = await routeRelayedRequest(
        new Request("http://localhost/tags", {
          method: "POST",
          headers: { "content-type": FORM_TYPE },
          body: "tag=a&tag=b",
        }),
      );

      expect(response?.status).toBe(200);
      expect(seen[0]?.tags).toEqual(["a", "b"]);
    });
  });

  describe("mock.listen()", () => {
    let mock: Schmock.CallableMockInstance | undefined;

    afterEach(() => {
      mock?.close();
      mock = undefined;
    });

    it("passes every value of a repeated name beside the last-wins body", async () => {
      const recording = recordingMock();
      mock = recording.mock;
      const { port } = await mock.listen(0);

      const response = await fetch(`http://127.0.0.1:${port}/tags`, {
        method: "POST",
        headers: { "content-type": `${FORM_TYPE}; charset=UTF-8` },
        body: "tag=a&tag=b",
      });

      expect(response.status).toBe(200);
      expect(recording.seen).toEqual([
        { body: { tag: "b" }, tags: ["a", "b"], hasForm: true },
      ]);
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

    it("passes every value of a repeated name beside the last-wins body", async () => {
      const { mock, seen } = recordingMock();
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

      await fetch(`http://127.0.0.1:${address.port}/tags`, {
        method: "POST",
        headers: { "content-type": FORM_TYPE },
        body: "tag=a&tag=b",
      });

      expect(seen).toEqual([
        { body: { tag: "b" }, tags: ["a", "b"], hasForm: true },
      ]);
    });
  });
});
