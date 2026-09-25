import { getResponseParts, schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { type ValidationPluginOptions, validationPlugin } from "./index";

function context(
  overrides: Partial<Schmock.PluginContext> = {},
): Schmock.PluginContext {
  return {
    path: "/items/1",
    route: {},
    method: "GET",
    params: {},
    query: {},
    headers: {},
    state: new Map(),
    ...overrides,
  };
}

type ResponseRules = NonNullable<ValidationPluginOptions["response"]>;

const idSchema: ResponseRules["body"] = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer" } },
  additionalProperties: false,
};

function validating(statuses?: ResponseRules["statuses"]): Schmock.Plugin {
  return validationPlugin({
    response:
      statuses === undefined
        ? { body: idSchema }
        : { body: idSchema, statuses },
  });
}

function isValidationFailure(response: unknown): boolean {
  const parts = getResponseParts(response);
  return (
    parts.kind === "object" &&
    parts.status === 500 &&
    typeof parts.body === "object" &&
    parts.body !== null &&
    "code" in parts.body &&
    parts.body.code === "RESPONSE_VALIDATION_ERROR"
  );
}

/** Tuples whose third element core refuses as headers. */
const malformedHeaderElements: ReadonlyArray<[string, unknown]> = [
  ["a string", "not-a-record"],
  ["an array", ["x-a"]],
  ["null", null],
  ["a number", 5],
  ["a record with a non-string value", { n: 5 }],
];

describe("validationPlugin consumes core's response decomposition (R9)", () => {
  describe("a tuple whose third element is not a string record", () => {
    for (const [label, third] of malformedHeaderElements) {
      it(`validates the body element when the third is ${label}`, async () => {
        const valid = [200, { id: 1 }, third];
        const invalid = [200, { id: "one" }, third];

        const passed = await validating().process(context(), valid);
        const failed = await validating().process(context(), invalid);

        expect(getResponseParts(valid).kind).toBe("tuple");
        expect(passed.response).toBe(valid);
        expect(isValidationFailure(failed.response)).toBe(true);
      });

      it(`scopes by the tuple status when the third is ${label}`, async () => {
        const response = [404, { id: "one" }, third];

        const result = await validating("2xx").process(context(), response);

        expect(result.response).toBe(response);
      });
    }

    it("lets a valid body reach core, which rejects it as INVALID_RESPONSE", async () => {
      const mock = schmock();
      mock("GET /items/:id", () => [200, { id: 1 }, "not-a-record"]).pipe(
        validating(),
      );

      const response = await mock.handle("GET", "/items/1");

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        code: "INVALID_RESPONSE",
        error: "Invalid response: headers must be a string record",
      });
    });

    it("answers RESPONSE_VALIDATION_ERROR first for an invalid body", async () => {
      const mock = schmock();
      mock("GET /items/:id", () => [200, { id: "one" }, { n: 5 }]).pipe(
        validating(),
      );

      const response = await mock.handle("GET", "/items/1");

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        code: "RESPONSE_VALIDATION_ERROR",
      });
    });
  });

  describe("judges exactly the body and status getResponseParts reports", () => {
    const shapes: ReadonlyArray<[string, unknown]> = [
      ["a plain valid body", { id: 1 }],
      ["a plain invalid body", { id: "one" }],
      ["a valid tuple", [200, { id: 1 }]],
      ["an invalid tuple", [201, { id: "one" }, { "x-a": "1" }]],
      ["a valid envelope", { status: 200, body: { id: 1 } }],
      [
        "an envelope with undefined headers",
        { status: 200, body: { id: 1 }, headers: undefined },
      ],
      [
        "an envelope with string headers",
        { status: 200, body: { id: 1 }, headers: { "x-a": "1" } },
      ],
      [
        "an object with non-string headers (delivered whole)",
        { status: 200, body: { id: 1 }, headers: { n: 1 } },
      ],
      [
        "an object with array headers (delivered whole)",
        { status: 200, body: { id: 1 }, headers: ["x"] },
      ],
      [
        "an object with a string status (delivered whole)",
        { status: "200", body: { id: 1 } },
      ],
      ["an out-of-range status pair (delivered whole)", [99, { id: 1 }]],
      ["a four-element array (delivered whole)", [200, { id: 1 }, {}, {}]],
      ["null", null],
      ["undefined", undefined],
    ];

    for (const [label, response] of shapes) {
      it(`validates ${label} as core delivers it`, async () => {
        const parts = getResponseParts(response);
        const bodyIsValid =
          typeof parts.body === "object" &&
          parts.body !== null &&
          !Array.isArray(parts.body) &&
          Object.keys(parts.body).length === 1 &&
          "id" in parts.body &&
          Number.isInteger(parts.body.id);

        const result = await validating().process(context(), response);

        if (bodyIsValid) {
          expect(result.response).toBe(response);
        } else {
          expect(isValidationFailure(result.response)).toBe(true);
        }
      });
    }

    it("pins which of those shapes pass", async () => {
      const passing: string[] = [];
      for (const [label, response] of shapes) {
        const result = await validating().process(context(), response);
        if (result.response === response) passing.push(label);
      }

      expect(passing).toEqual([
        "a plain valid body",
        "a valid tuple",
        "a valid envelope",
        "an envelope with undefined headers",
        "an envelope with string headers",
      ]);
    });

    it("scopes a bare null by the 204 core answers with", async () => {
      const only200 = await validating([200]).process(context(), null);
      const only204 = await validating([204]).process(context(), null);

      expect(getResponseParts(null).status).toBe(204);
      expect(only200.response).toBeNull();
      expect(isValidationFailure(only204.response)).toBe(true);
    });

    it("scopes an object with non-string headers as a plain 200", async () => {
      // Not an envelope, so its own `status: 404` is not the answer's status.
      const response = { status: 404, body: { id: 1 }, headers: { n: 1 } };

      const result = await validating("2xx").process(context(), response);

      expect(getResponseParts(response).status).toBe(200);
      expect(isValidationFailure(result.response)).toBe(true);
    });
  });

  describe("tuple headers are read while the plugin runs", () => {
    // getResponseParts copies the carried headers, so with a response schema
    // the plugin now reads the third element itself. Before R9 it was first
    // read by core's parser, and a throwing getter surfaced as INTERNAL_ERROR.
    function throwingHeaders(): Record<string, string> {
      return {
        get "x-a"(): string {
          throw new Error("boom");
        },
      };
    }

    it("reports a throwing header getter as the validation plugin's failure", async () => {
      const mock = schmock();
      mock("GET /items/:id", () => [200, { id: 1 }, throwingHeaders()]).pipe(
        validating(),
      );

      const response = await mock.handle("GET", "/items/1");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Plugin "validation" failed: boom',
        code: "PLUGIN_ERROR",
      });
    });

    it("leaves it to core when no response schema is configured", async () => {
      const mock = schmock();
      mock("GET /items/:id", () => [200, { id: 1 }, throwingHeaders()]).pipe(
        validationPlugin({ request: { query: { type: "object" } } }),
      );

      const response = await mock.handle("GET", "/items/1");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "boom", code: "INTERNAL_ERROR" });
    });
  });
});
