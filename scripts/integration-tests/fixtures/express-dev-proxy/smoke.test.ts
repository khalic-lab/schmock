/**
 * E2E: Express development proxy pattern.
 *
 * The most common real-world setup: an Express server that serves
 * your frontend, with Schmock mocking the API routes so you can
 * develop without a real backend. Uses OpenAPI spec to auto-register
 * routes with seed data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { schmock } from "@schmock/core";
import { openapi } from "@schmock/openapi";
import { toExpress } from "@schmock/express";

let server: Server;
let base: string;
let mock: ReturnType<typeof schmock>;

beforeAll(async () => {
  mock = schmock({ state: {} });

  // Auto-register routes from OpenAPI spec with seed data
  const plugin = await openapi({
    spec: resolve(import.meta.dirname, "spec.yaml"),
    seed: {
      products: [
        { id: 1, name: "Keyboard", price: 79.99 },
        { id: 2, name: "Mouse", price: 29.99 },
        { id: 3, name: "Monitor", price: 349.99 },
      ],
    },
  });
  mock.pipe(plugin);

  const app = express();
  app.use(express.json());

  // Mock API routes
  app.use("/api", toExpress(mock));

  // Simulated "static" frontend route alongside API
  app.get("/", (_req, res) => {
    res.send("<html><body>App</body></html>");
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", env: "development" });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") {
        base = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

describe("E2E: Express dev proxy with OpenAPI", () => {
  describe("auto-registered routes from spec", () => {
    it("GET /api/products returns seeded data", async () => {
      const res = await fetch(`${base}/api/products`);
      expect(res.status).toBe(200);

      const products = await res.json();
      expect(products).toHaveLength(3);
      expect(products[0].name).toBe("Keyboard");
      expect(products[2].price).toBe(349.99);
    });

    it("GET /api/products/:id returns single product", async () => {
      const res = await fetch(`${base}/api/products/1`);
      expect(res.status).toBe(200);

      const product = await res.json();
      expect(product.name).toBe("Keyboard");
      expect(product.id).toBe(1);
    });

    it("POST /api/products creates and persists a product", async () => {
      const res = await fetch(`${base}/api/products`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Webcam", price: 59.99 }),
      });
      expect(res.status).toBe(201);

      const created = await res.json();
      expect(created.name).toBe("Webcam");
      expect(typeof created.id).toBe("number");

      // Verify it persists — GET should now return 4 products
      const listRes = await fetch(`${base}/api/products`);
      const products = await listRes.json();
      expect(products.length).toBeGreaterThanOrEqual(4);
      expect(products.some((p: { name: string }) => p.name === "Webcam")).toBe(true);
    });

    it("DELETE /api/products/:id removes a product", async () => {
      const res = await fetch(`${base}/api/products/2`, { method: "DELETE" });
      expect(res.status).toBe(204);

      // Verify it's gone
      const listRes = await fetch(`${base}/api/products`);
      const products = await listRes.json();
      expect(products.some((p: { id: number }) => p.id === 2)).toBe(false);
    });
  });

  describe("coexistence with regular express routes", () => {
    it("serves HTML frontend at /", async () => {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);

      const html = await res.text();
      expect(html).toContain("<html>");
      expect(html).toContain("App");
    });

    it("serves health check alongside mocked API", async () => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.env).toBe("development");
    });
  });

  describe("spy API works through express", () => {
    it("tracks all requests made through the proxy", () => {
      expect(mock.called()).toBe(true);
      // We've made several requests by now
      expect(mock.callCount()).toBeGreaterThanOrEqual(4);

      // Can filter by method + path
      expect(mock.called("GET", "/products")).toBe(true);
      expect(mock.called("POST", "/products")).toBe(true);
    });

    it("last request has correct data", () => {
      const history = mock.history("POST", "/products");
      expect(history.length).toBeGreaterThanOrEqual(1);

      const last = history[history.length - 1];
      expect(last.body).toEqual({ name: "Webcam", price: 59.99 });
    });
  });
});
