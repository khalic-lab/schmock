import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { schmock, notFound, created, noContent } from "@schmock/core";
import { toExpress } from "@schmock/express";

let server: Server;
let base: string;
let mock: ReturnType<typeof schmock>;

beforeAll(async () => {
  mock = schmock();

  mock("GET /users", [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ]);
  mock("GET /users/:id", ({ params }) => ({
    id: Number(params.id),
    name: `User ${params.id}`,
  }));
  mock("POST /users", ({ body }) => created(body as object));
  mock("DELETE /users/:id", noContent());
  mock("GET /missing", notFound("gone"));
  mock("GET /error", [500, { message: "broken" }]);
  mock("GET /headers", ({ headers }) => ({
    auth: headers.authorization,
    custom: headers["x-custom"],
  }));
  mock("GET /query", ({ query }) => ({
    q: query.q,
    page: query.page,
  }));

  const app = express();
  app.use(express.json());
  app.use("/api", toExpress(mock));

  // Static route alongside schmock
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
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

describe("Express adapter integration", () => {
  describe("basic CRUD", () => {
    it("GET list returns mocked data", async () => {
      const res = await fetch(`${base}/api/users`);
      expect(res.status).toBe(200);
      const users = await res.json();
      expect(users).toHaveLength(2);
      expect(users[0].name).toBe("Alice");
    });

    it("GET with route params", async () => {
      const res = await fetch(`${base}/api/users/42`);
      expect(res.status).toBe(200);
      const user = await res.json();
      expect(user.id).toBe(42);
      expect(user.name).toBe("User 42");
    });

    it("POST with JSON body returns 201", async () => {
      const res = await fetch(`${base}/api/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Charlie" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("Charlie");
    });

    it("DELETE returns 204", async () => {
      const res = await fetch(`${base}/api/users/1`, { method: "DELETE" });
      expect(res.status).toBe(204);
    });
  });

  describe("error responses", () => {
    it("notFound helper returns 404", async () => {
      const res = await fetch(`${base}/api/missing`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe("gone");
    });

    it("500 error status returns correctly", async () => {
      const res = await fetch(`${base}/api/error`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.message).toBe("broken");
    });
  });

  describe("passthrough", () => {
    it("unmatched schmock routes fall through to express", async () => {
      const res = await fetch(`${base}/api/nonexistent`);
      // Express returns 404 for unmatched routes (not schmock's 404)
      expect(res.status).toBe(404);
    });

    it("non-schmock express routes still work", async () => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    });
  });

  describe("headers and query params", () => {
    it("forwards custom headers to schmock handlers", async () => {
      const res = await fetch(`${base}/api/headers`, {
        headers: {
          Authorization: "Bearer token123",
          "X-Custom": "hello",
        },
      });
      const body = await res.json();
      expect(body.auth).toBe("Bearer token123");
      expect(body.custom).toBe("hello");
    });

    it("forwards query parameters to schmock handlers", async () => {
      const res = await fetch(`${base}/api/query?q=search&page=3`);
      const body = await res.json();
      expect(body.q).toBe("search");
      expect(body.page).toBe("3");
    });
  });

  describe("spy API through express", () => {
    it("tracks requests made through express", () => {
      expect(mock.called("GET", "/users")).toBe(true);
      expect(mock.callCount("GET", "/users")).toBeGreaterThanOrEqual(1);
      expect(mock.history().length).toBeGreaterThan(0);
    });
  });
});
