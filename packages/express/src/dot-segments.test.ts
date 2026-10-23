import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CallableMockInstance } from "@schmock/core";
import { schmock } from "@schmock/core";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toExpress } from "./index";

function routingMock(): CallableMockInstance {
  const mock = schmock();
  mock("GET /", { route: "GET /" });
  mock("GET /pets", { route: "GET /pets" });
  mock("GET /pets/:id", ({ params }) => ({
    route: "GET /pets/:id",
    id: params.id,
  }));
  return mock;
}

/** The path the middleware hands mock.handle() for a hand-built request. */
async function routedPathOf(req: Partial<Request>): Promise<string> {
  const handle = vi.fn(async () => ({ status: 200, body: "ok", headers: {} }));
  const mock = { handle } as unknown as CallableMockInstance;
  const res = {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    end: vi.fn(),
  } as unknown as Response;
  await toExpress(mock)(
    { method: "GET", path: "/", headers: {}, query: {}, ...req } as Request,
    res,
    vi.fn() as NextFunction,
  );
  const path: unknown = handle.mock.calls[0]?.[1];
  if (typeof path !== "string") throw new Error("mock.handle() was not called");
  return path;
}

/** GET a raw request target, which no client-side URL parsing rewrites. */
function rawGet(
  port: number,
  target: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: target, method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Express resolves dot segments before routing (decision 57)", () => {
  describe("the routed path", () => {
    it("resolves '..' and '.' segments", async () => {
      expect(
        await routedPathOf({ url: "/a/../pets", path: "/a/../pets" }),
      ).toBe("/pets");
      expect(await routedPathOf({ url: "/a/./pets", path: "/a/./pets" })).toBe(
        "/a/pets",
      );
      expect(await routedPathOf({ url: "/pets/..", path: "/pets/.." })).toBe(
        "/",
      );
    });

    it("resolves percent-encoded dot segments", async () => {
      expect(
        await routedPathOf({ url: "/a/%2e%2e/pets", path: "/a/%2e%2e/pets" }),
      ).toBe("/pets");
      expect(
        await routedPathOf({ url: "/a/%2E/pets", path: "/a/%2E/pets" }),
      ).toBe("/a/pets");
    });

    it("keeps a leading '//' as part of the path", async () => {
      expect(await routedPathOf({ url: "//users", path: "//users" })).toBe(
        "//users",
      );
    });

    it("reads the path of req.url, not its query", async () => {
      expect(
        await routedPathOf({ url: "/a/../pets?x=/..", path: "/a/../pets" }),
      ).toBe("/pets");
    });

    it("keeps req.path for a hand-built request without a URL", async () => {
      expect(await routedPathOf({ path: "/a/../pets" })).toBe("/a/../pets");
    });
  });

  describe("over a raw socket, alongside mock.listen()", () => {
    const servers: Array<{ close(): void }> = [];

    afterEach(() => {
      for (const server of servers.splice(0)) server.close();
    });

    async function expressPort(mock: CallableMockInstance): Promise<number> {
      const app = express();
      app.use(toExpress(mock));
      app.use((_req, res) => {
        res.status(418).json({ route: "next()" });
      });
      const server: Server = await new Promise((resolve) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
      });
      servers.push(server);
      return (server.address() as AddressInfo).port;
    }

    async function listenPort(mock: CallableMockInstance): Promise<number> {
      const { port } = await mock.listen(0, "127.0.0.1");
      servers.push({ close: () => mock.close() });
      return port;
    }

    it.each([
      ["/a/../pets", "GET /pets"],
      ["/a/%2e%2e/pets", "GET /pets"],
      ["/pets/..", "GET /"],
    ])("routes %s as %s on both", async (target, route) => {
      const viaExpress = await rawGet(await expressPort(routingMock()), target);
      const viaListen = await rawGet(await listenPort(routingMock()), target);

      expect(JSON.parse(viaExpress.body)).toMatchObject({ route });
      expect(viaExpress).toEqual(viaListen);
    });
  });
});
