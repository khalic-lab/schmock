/// <reference path="../../packages/core/schmock.d.ts" />

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Import from cli.ts directly to avoid index.ts auto-run side effect
import { createCliServer } from "../../packages/cli/src/cli";
import { afterEach, describe, expect, it } from "vitest";
import { PETSTORE_SPEC, fetchJson } from "./helpers";

describe("CLI Integration", () => {
  let server: Schmock.CliServer | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("CLI with petstore spec: CRUD operations", async () => {
    server = await createCliServer({ spec: PETSTORE_SPEC, port: 0 });
    const { port } = server;

    // POST
    const created = await fetchJson(port, "/pets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "CliPet", tag: "cli" }),
    });
    expect(created.status).toBe(201);
    expect(created.body).toHaveProperty("name", "CliPet");
    const petId = created.body.petId;

    // GET list
    const list = await fetchJson(port, "/pets");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);

    // GET by id
    const single = await fetchJson(port, `/pets/${petId}`);
    expect(single.status).toBe(200);
    expect(single.body.name).toBe("CliPet");

    // DELETE
    const deleted = await fetchJson(port, `/pets/${petId}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
  });

  it("CLI with seed data", async () => {
    const seedPath = join(tmpdir(), `schmock-seed-${Date.now()}.json`);
    writeFileSync(
      seedPath,
      JSON.stringify({
        pets: [
          { petId: 1, name: "SeedPet1", tag: "seed" },
          { petId: 2, name: "SeedPet2", tag: "seed" },
        ],
      }),
    );

    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      seed: seedPath,
    });
    const { port } = server;

    const list = await fetchJson(port, "/pets");
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(2);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "SeedPet1" }),
        expect.objectContaining({ name: "SeedPet2" }),
      ]),
    );
  });

  it("CLI with CORS enabled", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      cors: true,
    });
    const { port } = server;

    // OPTIONS preflight
    const preflight = await fetch(`http://127.0.0.1:${port}/pets`, {
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "GET",
    );

    // Regular request should also have CORS headers
    const res = await fetchJson(port, "/pets");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("CLI admin endpoint", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
    });
    const { port } = server;

    // Create some data first
    await fetchJson(port, "/pets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "AdminPet" }),
    });

    // GET routes
    const routes = await fetchJson(port, "/schmock-admin/routes");
    expect(routes.status).toBe(200);
    expect(Array.isArray(routes.body)).toBe(true);
    expect(routes.body.length).toBeGreaterThan(0);

    // GET state
    const state = await fetchJson(port, "/schmock-admin/state");
    expect(state.status).toBe(200);

    // GET history
    const history = await fetchJson(port, "/schmock-admin/history");
    expect(history.status).toBe(200);
    expect(Array.isArray(history.body)).toBe(true);
    expect(history.body.length).toBeGreaterThan(0);

    // POST reset
    const reset = await fetchJson(port, "/schmock-admin/reset", {
      method: "POST",
    });
    expect(reset.status).toBe(204);

    // Verify history cleared
    const afterReset = await fetchJson(port, "/schmock-admin/history");
    expect(afterReset.body.length).toBe(0);
  });

  it("CLI with request validation (errors flag)", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      errors: true,
    });
    const { port } = server;

    // POST with valid body
    const valid = await fetchJson(port, "/pets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ValidPet" }),
    });
    expect(valid.status).toBe(201);

    // POST with invalid body (missing required "name" per petstore NewPet schema)
    const invalid = await fetchJson(port, "/pets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "no-name" }),
    });
    // With validateRequests enabled, should return 400
    expect(invalid.status).toBe(400);
  });
});
