import { schmock } from "@schmock/core";
import { fakerPlugin } from "@schmock/faker";

const mock = schmock();

mock("GET /api/users", null, { contentType: "application/json" }).pipe(
  fakerPlugin({
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          email: { type: "string", format: "email" },
        },
        required: ["id", "name", "email"],
      },
    },
  }),
);

const res = await mock.handle("GET", "/api/users");
if (res.status !== 200) throw new Error("Status: " + res.status);

const users = res.body as Array<{ id: number; name: string; email: string }>;
if (!Array.isArray(users)) throw new Error("Expected array, got: " + typeof users);
if (users.length === 0) throw new Error("Expected generated users, got empty array");
if (typeof users[0].email !== "string") throw new Error("Expected email string");

console.log("@schmock/faker: all checks passed");
