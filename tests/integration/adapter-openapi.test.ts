/// <reference path="../../packages/core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { toExpress } from "@schmock/express";
import { openapi } from "@schmock/openapi";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { PETSTORE_SPEC } from "./helpers";

describe("Express + OpenAPI Integration", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => {
    mock?.close();
  });

  function createApp(
    options?: Parameters<typeof toExpress>[1],
  ): express.Express {
    const app = express();
    app.use(express.json());
    app.use(toExpress(mock, options));
    return app;
  }

  it("Express + petstore CRUD", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: PETSTORE_SPEC }));

    const app = createApp();

    // POST
    const created = await request(app)
      .post("/pets")
      .send({ name: "Buddy", tag: "dog" })
      .expect(201);
    expect(created.body).toHaveProperty("name", "Buddy");
    const petId = created.body.petId;

    // GET list
    const list = await request(app).get("/pets").expect(200);
    expect(list.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Buddy" })]),
    );

    // GET by id
    const single = await request(app).get(`/pets/${petId}`).expect(200);
    expect(single.body).toHaveProperty("name", "Buddy");

    // PATCH update
    await request(app)
      .patch(`/pets/${petId}`)
      .send({ name: "Buddy Jr" })
      .expect(200);

    // DELETE
    await request(app).delete(`/pets/${petId}`).expect(204);

    // Verify gone
    await request(app).get(`/pets/${petId}`).expect(404);
  });

  it("Express + openapi security", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Secured", version: "1.0.0" },
          components: {
            securitySchemes: {
              bearerAuth: { type: "http", scheme: "bearer" },
            },
          },
          security: [{ bearerAuth: [] }],
          paths: {
            "/protected": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: { secret: { type: "string" } },
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

    const app = createApp();

    // No auth → 401
    await request(app).get("/protected").expect(401);

    // With auth → 200
    await request(app)
      .get("/protected")
      .set("Authorization", "Bearer test-token")
      .expect(200);
  });

  it("Express route-not-found fallback", async () => {
    mock = schmock({ state: {} });
    mock("GET /known", { found: true });

    const app = express();
    app.use(express.json());
    app.use(toExpress(mock));
    // Custom 404 handler
    app.use((_req: express.Request, res: express.Response) => {
      res.status(404).json({ custom: "not found" });
    });

    // Known route → 200
    await request(app).get("/known").expect(200);

    // Unknown route → passed to next() → our custom 404
    const res = await request(app).get("/unknown").expect(404);
    expect(res.body).toEqual({ custom: "not found" });
  });

  it("Express + Prefer header", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: PETSTORE_SPEC }));

    const app = createApp();

    // Prefer: dynamic=true
    const res = await request(app)
      .get("/pets")
      .set("Prefer", "dynamic=true")
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it("Express + custom error formatter", async () => {
    mock = schmock({ state: {} });
    mock("GET /fail", () => {
      throw new Error("test failure");
    });

    const app = express();
    app.use(express.json());
    app.use(
      toExpress(mock, {
        passErrorsToNext: false,
      }),
    );

    // The error should be caught and a 500 returned
    const res = await request(app).get("/fail").expect(500);
    expect(res.body).toHaveProperty("error");
  });

  it("Express + beforeRequest/beforeResponse hooks", async () => {
    mock = schmock({ state: {} });
    mock("GET /data", { original: true });

    const app = express();
    app.use(express.json());
    app.use(
      toExpress(mock, {
        beforeRequest: (req) => {
          // Add a custom header
          return {
            headers: { "x-intercepted": "true" },
          };
        },
        beforeResponse: (response) => {
          // Add a custom header to the response
          return {
            ...response,
            headers: {
              ...response.headers,
              "x-modified": "yes",
            },
          };
        },
      }),
    );

    const res = await request(app).get("/data").expect(200);
    expect(res.headers["x-modified"]).toBe("yes");
  });
});
