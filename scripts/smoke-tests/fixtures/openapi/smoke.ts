import { schmock } from "@schmock/core";
import { openapi } from "@schmock/openapi";
import { resolve } from "node:path";

const mock = schmock({ state: {} });

const plugin = await openapi({
  spec: resolve(import.meta.dirname, "spec.yaml"),
  seed: {
    items: [
      { id: 1, name: "Widget" },
      { id: 2, name: "Gadget" },
    ],
  },
});

mock.pipe(plugin);

// GET /items — should return seeded data
const r1 = await mock.handle("GET", "/items");
if (r1.status !== 200) throw new Error("GET status: " + r1.status);
const items = r1.body as Array<{ id: number; name: string }>;
if (items.length !== 2) throw new Error("Expected 2 items, got " + items.length);
if (items[0].name !== "Widget") throw new Error("First item wrong: " + items[0].name);

// POST /items — should create
const r2 = await mock.handle("POST", "/items", {
  body: { name: "Doohickey" },
  headers: { "content-type": "application/json" },
});
if (r2.status !== 201) throw new Error("POST status: " + r2.status);

// Verify created item appears in list
const r3 = await mock.handle("GET", "/items");
const after = r3.body as Array<{ name: string }>;
if (!after.some((i) => i.name === "Doohickey")) throw new Error("Created item not in list");

console.log("@schmock/openapi: all checks passed");
