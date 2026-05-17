import { schmock } from "@schmock/core";
import { validationPlugin } from "@schmock/validation";

const mock = schmock();
mock("POST /users", ({ body }) => [201, body]).pipe(
  validationPlugin({
    request: {
      body: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          email: { type: "string", format: "email" },
        },
        required: ["name", "email"],
      },
    },
  }),
);

// Happy path
const ok = await mock.handle("POST", "/users", {
  body: { name: "Alice", email: "alice@example.com" },
});
if (ok.status !== 201) throw new Error("Valid request status: " + ok.status);

// Missing required field -> 400
const missing = await mock.handle("POST", "/users", {
  body: { name: "Bob" },
});
if (missing.status !== 400)
  throw new Error("Missing-field status: " + missing.status);

// Bad email format -> 400 (confirms ajv-formats is wired)
const badFormat = await mock.handle("POST", "/users", {
  body: { name: "Carol", email: "not-an-email" },
});
if (badFormat.status !== 400)
  throw new Error("Bad-format status: " + badFormat.status);

console.log("@schmock/validation: all checks passed");
