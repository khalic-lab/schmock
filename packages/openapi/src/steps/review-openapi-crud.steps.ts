import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/review-openapi-crud.feature");

const json = (schema: Record<string, unknown>) => ({
  "application/json": { schema },
});

function spec(paths: Record<string, unknown>) {
  return {
    openapi: "3.0.3",
    info: { title: "CRUD review", version: "1.0.0" },
    paths,
  };
}

// ── Prefer ──────────────────────────────────────────────────────────────────

const statusSpec = spec({
  "/status": {
    get: {
      responses: {
        "200": {
          description: "ok",
          content: json({
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean", enum: [true] } },
          }),
        },
        default: {
          description: "error",
          content: json({
            type: "object",
            required: ["message"],
            properties: { message: { type: "string" } },
          }),
        },
      },
    },
  },
});

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  Scenario(
    "A Prefer code outside the HTTP status range falls through to the normal response",
    ({ Given, When, Then }) => {
      Given(
        "a status mock whose operation declares a 200 and a default response",
        async () => {
          mock = schmock();
          mock.pipe(await openapi({ spec: statusSpec }));
        },
      );

      When('I get the status with Prefer header "code=999"', async () => {
        response = await mock.handle("GET", "/status", {
          headers: { prefer: "code=999" },
        });
      });

      Then("the status response is 200 with the declared success body", () => {
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true });
      });
    },
  );
});
