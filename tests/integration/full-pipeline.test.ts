/// <reference path="../../packages/core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { openapi } from "@schmock/openapi";
import { afterEach, describe, expect, it } from "vitest";
import {
  PETSTORE_SPEC,
  SCALAR_GALAXY_SPEC,
  TRAIN_TRAVEL_SPEC,
  fetchJson,
} from "./helpers";

describe("Full Pipeline: schmock → openapi → listen → fetch → close", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => {
    mock?.close();
  });

  it("Petstore CRUD via HTTP", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: PETSTORE_SPEC }));

    const { port } = await mock.listen(0);

    // POST — create a pet
    const created = await fetchJson(port, "/pets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fluffy", tag: "cat" }),
    });
    expect(created.status).toBe(201);
    expect(created.body).toHaveProperty("name", "Fluffy");
    const petId = created.body.petId;

    // GET list — should include the new pet
    const list = await fetchJson(port, "/pets");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.some((p: any) => p.name === "Fluffy")).toBe(true);

    // GET by id
    const fetched = await fetchJson(port, `/pets/${petId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toHaveProperty("name", "Fluffy");

    // PATCH — update
    const updated = await fetchJson(port, `/pets/${petId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fluffy II", tag: "dog" }),
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toHaveProperty("name", "Fluffy II");

    // DELETE
    const deleted = await fetchJson(port, `/pets/${petId}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    // Verify gone
    const afterDelete = await fetchJson(port, `/pets/${petId}`);
    expect(afterDelete.status).toBe(404);
  });

  it("Train Travel spec pipeline", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: TRAIN_TRAVEL_SPEC }));

    const { port } = await mock.listen(0);

    // The train travel spec has stations and trips — verify routes are registered
    const routes = mock.getRoutes();
    expect(routes.length).toBeGreaterThan(0);

    // Pick a GET route and verify it responds
    const getRoutes = routes.filter((r) => r.method === "GET");
    expect(getRoutes.length).toBeGreaterThan(0);

    const res = await fetchJson(port, getRoutes[0].path);
    expect(res.status).toBeDefined();
    // Should not crash — any status is valid
    expect(typeof res.status).toBe("number");
  });

  it("Scalar Galaxy circular refs don't hang or crash", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: SCALAR_GALAXY_SPEC }));

    const { port } = await mock.listen(0);

    const routes = mock.getRoutes();
    expect(routes.length).toBeGreaterThan(0);

    // Fetch a list endpoint — should respond without hanging
    const getRoutes = routes.filter((r) => r.method === "GET");
    if (getRoutes.length > 0) {
      const res = await fetchJson(port, getRoutes[0].path);
      expect(res.status).toBeDefined();
    }
  });

  it("Pipeline with seed data", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: PETSTORE_SPEC,
        seed: {
          pets: [
            { petId: 1, name: "Rex", tag: "dog" },
            { petId: 2, name: "Whiskers", tag: "cat" },
          ],
        },
      }),
    );

    const { port } = await mock.listen(0);

    // GET list — should contain seeded items
    const list = await fetchJson(port, "/pets");
    expect(list.status).toBe(200);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rex" }),
        expect.objectContaining({ name: "Whiskers" }),
      ]),
    );

    // POST adds a new item
    const created = await fetchJson(port, "/pets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Goldie", tag: "fish" }),
    });
    expect(created.status).toBe(201);

    // GET list now includes all three
    const updated = await fetchJson(port, "/pets");
    expect(updated.body.length).toBe(3);
  });

  it("Request history through HTTP", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: PETSTORE_SPEC }));

    const { port } = await mock.listen(0);

    expect(mock.called()).toBe(false);

    await fetchJson(port, "/pets");
    await fetchJson(port, "/pets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test" }),
    });
    await fetchJson(port, "/pets");

    expect(mock.callCount()).toBe(3);
    expect(mock.called("GET", "/pets")).toBe(true);
    expect(mock.callCount("GET", "/pets")).toBe(2);
    expect(mock.callCount("POST", "/pets")).toBe(1);

    const last = mock.lastRequest("POST", "/pets");
    expect(last).toBeDefined();
    expect(last?.body).toEqual({ name: "Test" });
  });

  it("Reset mid-session clears state and re-seeds", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: PETSTORE_SPEC,
        seed: { pets: [{ petId: 1, name: "Rex", tag: "dog" }] },
      }),
    );

    const { port } = await mock.listen(0);

    // Confirm seed data is present
    const before = await fetchJson(port, "/pets");
    expect(before.body.length).toBe(1);

    // Add another pet
    await fetchJson(port, "/pets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Extra", tag: "test" }),
    });
    const withExtra = await fetchJson(port, "/pets");
    expect(withExtra.body.length).toBe(2);

    // resetState clears all state — seeder flag is gone, next request re-seeds
    mock.resetState();

    const after = await fetchJson(port, "/pets");
    expect(after.status).toBe(200);
    // After resetState, the seeder re-runs with original seed → back to 1
    expect(after.body.length).toBe(1);
    expect(after.body[0].name).toBe("Rex");
  });

  it("Prefer header via HTTP: dynamic=true", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: PETSTORE_SPEC, fakerSeed: 42 }));

    const { port } = await mock.listen(0);

    // Use Prefer: dynamic=true to force regeneration from schema
    const dynamic = await fetchJson(port, "/pets", {
      headers: { prefer: "dynamic=true" },
    });
    expect(dynamic.status).toBe(200);
    expect(dynamic.body).toBeDefined();
  });

  it("Security validation via HTTP", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Secured API", version: "1.0.0" },
          components: {
            securitySchemes: {
              bearerAuth: { type: "http", scheme: "bearer" },
            },
          },
          security: [{ bearerAuth: [] }],
          paths: {
            "/secret": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: { data: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        security: true,
      }),
    );

    const { port } = await mock.listen(0);

    // Without auth → 401
    const noAuth = await fetchJson(port, "/secret");
    expect(noAuth.status).toBe(401);
    expect(noAuth.body).toHaveProperty("code", "UNAUTHORIZED");

    // With auth → 200
    const withAuth = await fetchJson(port, "/secret", {
      headers: { authorization: "Bearer my-token-123" },
    });
    expect(withAuth.status).toBe(200);
  });

  it("Dynamic generation via HTTP with Prefer header", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: PETSTORE_SPEC, fakerSeed: 42 }));

    const { port } = await mock.listen(0);

    const normal = await fetchJson(port, "/pets");
    expect(normal.status).toBe(200);

    const dynamic = await fetchJson(port, "/pets", {
      headers: { prefer: "dynamic=true" },
    });
    expect(dynamic.status).toBe(200);
  });

  it("Port reuse after close", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: PETSTORE_SPEC }));

    const { port } = await mock.listen(0);
    mock.close();

    // Re-listen on same port
    await mock.listen(port);
    const res = await fetchJson(port, "/pets");
    expect(res.status).toBe(200);
  });

  it("Multiple listen calls throws", async () => {
    mock = schmock({ state: {} });
    mock("GET /test", { ok: true });

    await mock.listen(0);

    // listen() throws synchronously if server already exists
    expect(() => mock.listen(0)).toThrow(/already running/i);
  });
});
