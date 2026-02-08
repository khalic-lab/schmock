import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { CliServer } from "../cli";
import { createCliServer } from "../cli";

const feature = await loadFeature("../../features/admin-api.feature");

const simpleSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/items": {
      get: { responses: { "200": { description: "OK" } } },
    },
  },
};

async function fetchJson(
  server: CliServer,
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(
    `http://${server.hostname}:${server.port}${path}`,
    { method },
  );
  const status = res.status;
  if (status === 204) return { status, body: undefined };
  const body: unknown = await res.json();
  return { status, body };
}

describeFeature(feature, ({ Scenario }) => {
  Scenario("List registered routes", ({ Given, When, Then, And }) => {
    let server: CliServer;
    let response: { status: number; body: unknown };

    Given("a CLI server with admin enabled and a simple spec", async () => {
      server = await createCliServer({ spec: simpleSpec as never, port: 0, admin: true });
    });

    When('I request "GET /schmock-admin/routes"', async () => {
      response = await fetchJson(server, "GET", "/schmock-admin/routes");
      server.close();
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });

    And("the response body is an array of route objects", () => {
      expect(Array.isArray(response.body)).toBe(true);
      const routes = response.body as Array<{ method: string; path: string }>;
      expect(routes.length).toBeGreaterThan(0);
      expect(routes[0]).toHaveProperty("method");
      expect(routes[0]).toHaveProperty("path");
    });
  });

  Scenario("Inspect server state", ({ Given, When, Then, And }) => {
    let server: CliServer;
    let response: { status: number; body: unknown };

    Given("a CLI server with admin enabled and a simple spec", async () => {
      server = await createCliServer({ spec: simpleSpec as never, port: 0, admin: true });
    });

    When('I request "GET /schmock-admin/state"', async () => {
      response = await fetchJson(server, "GET", "/schmock-admin/state");
      server.close();
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });

    And("the response body is a state object", () => {
      expect(typeof response.body).toBe("object");
      expect(response.body).not.toBeNull();
    });
  });

  Scenario("Reset the mock via admin", ({ Given, When, Then }) => {
    let server: CliServer;
    let response: { status: number; body: unknown };

    Given("a CLI server with admin enabled and a simple spec", async () => {
      server = await createCliServer({ spec: simpleSpec as never, port: 0, admin: true });
    });

    When('I send "POST /schmock-admin/reset"', async () => {
      response = await fetchJson(server, "POST", "/schmock-admin/reset");
      server.close();
    });

    Then("the response status is 204", () => {
      expect(response.status).toBe(204);
    });
  });

  Scenario("View request history", ({ Given, When, Then, And }) => {
    let server: CliServer;
    let response: { status: number; body: unknown };

    Given("a CLI server with admin enabled and a simple spec", async () => {
      server = await createCliServer({ spec: simpleSpec as never, port: 0, admin: true });
    });

    When("I make a request to the mock API", async () => {
      await fetch(`http://${server.hostname}:${server.port}/items`);
    });

    And('I request "GET /schmock-admin/history"', async () => {
      response = await fetchJson(server, "GET", "/schmock-admin/history");
      server.close();
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });

    And("the response body is an array", () => {
      expect(Array.isArray(response.body)).toBe(true);
      const history = response.body as unknown[];
      expect(history.length).toBeGreaterThan(0);
    });
  });

  Scenario("Admin routes are 404 without flag", ({ Given, When, Then }) => {
    let server: CliServer;
    let response: { status: number; body: unknown };

    Given("a CLI server without admin enabled", async () => {
      server = await createCliServer({ spec: simpleSpec as never, port: 0 });
    });

    When('I request "GET /schmock-admin/routes"', async () => {
      response = await fetchJson(server, "GET", "/schmock-admin/routes");
      server.close();
    });

    Then("the response status is 404", () => {
      expect(response.status).toBe(404);
    });
  });
});
