import { afterEach, describe, expect, it } from "vitest";
import { schmock } from "./index.js";

/*
 * A body whose toJSON yields a string (a Date) is normalized to its JSON
 * text, which a transport cannot tell from a string the route wrote. The
 * tuple forms skip the route's default content type, so without a label from
 * the normalizer their Date went out untyped while the function form went out
 * as application/json.
 */
describe("content type of a body serialized to a JSON string", () => {
  const EPOCH_TEXT = '"1970-01-01T00:00:00.000Z"';
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  describe("handle()", () => {
    it.each([
      ["a static tuple", [200, new Date(0)]],
      ["a tuple a function returns", () => [200, new Date(0)]],
      ["a function", () => new Date(0)],
      ["an envelope", { status: 200, body: new Date(0) }],
    ] satisfies Array<[string, Schmock.Generator]>)(
      "labels a Date from %s application/json",
      async (_label, generator) => {
        const mock = schmock();
        mock("GET /time", generator);

        const response = await mock.handle("GET", "/time");

        expect(response.body).toBe(EPOCH_TEXT);
        expect(response.headers).toEqual({
          "content-type": "application/json",
        });
      },
    );

    it("keeps a tuple's own content type", async () => {
      const mock = schmock();
      mock("GET /time", [200, new Date(0), { "content-type": "text/plain" }]);

      const response = await mock.handle("GET", "/time");

      expect(response.headers).toEqual({ "content-type": "text/plain" });
    });

    it("leaves a string a tuple returns untyped", async () => {
      const mock = schmock();
      mock("GET /text", [200, EPOCH_TEXT]);

      const response = await mock.handle("GET", "/text");

      expect(response.headers).toEqual({});
    });
  });

  it("sends a tuple's Date through intercept() as JSON", async () => {
    const mock = schmock();
    mock("GET /api/time", [200, new Date(0)]);
    const handle = mock.intercept({ passthrough: false });
    restore = () => handle.restore();

    const response = await fetch("http://localhost/api/time");

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toBe("1970-01-01T00:00:00.000Z");
  });
});
