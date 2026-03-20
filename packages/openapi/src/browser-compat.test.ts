import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { parseSpec } from "./parser";
import { loadSeed } from "./seed";
import { openapi } from "./plugin";

const fixturesDir = resolve(import.meta.dirname, "__fixtures__");
const packageRoot = resolve(import.meta.dirname, "..");

function readDist(relativePath: string): string {
  return readFileSync(resolve(packageRoot, relativePath), "utf-8");
}

describe("browser compatibility fixes", () => {
  describe("Issue 1: build output free of Node.js CJS shims", () => {
    it("faker build has no createRequire or node:module", () => {
      const content = readDist("../faker/dist/index.js");
      expect(content).not.toContain('from"node:module"');
      expect(content).not.toContain("createRequire");
    });

    it("openapi build has no createRequire or node:module", () => {
      const content = readDist("dist/index.js");
      expect(content).not.toContain('from"node:module"');
      expect(content).not.toContain("createRequire");
    });

    it("faker build has no top-level node: protocol imports", () => {
      const content = readDist("../faker/dist/index.js");
      const staticNodeImports = [...content.matchAll(/\bimport\s*\{[^}]+\}\s*from\s*"(node:[^"]+)"/g)]
        .map((m) => m[1]);
      expect(staticNodeImports).toEqual([]);
    });

    it("openapi build has no static node:module or node:fs imports", () => {
      const content = readDist("dist/index.js");
      const staticNodeImports = [...content.matchAll(/\bimport\s*\{[^}]+\}\s*from\s*"(node:[^"]+)"/g)]
        .map((m) => m[1]);
      expect(staticNodeImports).not.toContain("node:module");
      expect(staticNodeImports).not.toContain("node:fs");
    });

    it("openapi build only references node:fs inside dynamic import()", () => {
      const content = readDist("dist/index.js");
      const nodefsRefs = [...content.matchAll(/["']node:fs["']/g)];
      for (const match of nodefsRefs) {
        const idx = match.index!;
        const preceding = content.slice(Math.max(0, idx - 30), idx);
        expect(preceding).toContain("import(");
      }
    });
  });

  describe("Issue 2: parseSpec skips dereference for ref-free objects", () => {
    it("parses inline spec without $ref (no dereference needed)", async () => {
      const spec = await parseSpec({
        openapi: "3.0.3",
        info: { title: "No Refs", version: "1.0.0" },
        paths: {
          "/items": {
            get: {
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: {
                        type: "array",
                        items: { type: "object", properties: { id: { type: "integer" } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      expect(spec.title).toBe("No Refs");
      expect(spec.paths.length).toBe(1);
      expect(spec.paths[0].method).toBe("GET");
      expect(spec.paths[0].path).toBe("/items");
    });

    it("dereferences file-based specs with $ref pointers", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);
      expect(spec.title).toBe("Petstore");
      expect(spec.paths.length).toBeGreaterThan(0);

      const listPets = spec.paths.find((p) => p.method === "GET" && p.path === "/pets");
      expect(listPets).toBeDefined();
      const responseSchema = listPets?.responses.get(200)?.schema;
      expect(responseSchema).toBeDefined();
      // If $ref was unresolved, schema would still have $ref key
      expect(responseSchema).not.toHaveProperty("$ref");
    });

    it("dereferences inline object spec that HAS $ref pointers", async () => {
      const spec = await parseSpec({
        openapi: "3.0.3",
        info: { title: "With Refs", version: "1.0.0" },
        components: {
          schemas: {
            Item: {
              type: "object",
              properties: {
                id: { type: "integer" },
                name: { type: "string" },
              },
            },
          },
        },
        paths: {
          "/items": {
            get: {
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Item" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      expect(spec.title).toBe("With Refs");
      const getItems = spec.paths.find((p) => p.method === "GET" && p.path === "/items");
      expect(getItems).toBeDefined();
      const responseSchema = getItems?.responses.get(200)?.schema;
      expect(responseSchema).toBeDefined();
      expect(responseSchema).not.toHaveProperty("$ref");
      expect(responseSchema).toHaveProperty("type", "array");
    });

    it("handles $ref appearing in description text gracefully", async () => {
      const spec = await parseSpec({
        openapi: "3.0.3",
        info: { title: "Ref In Desc", version: "1.0.0" },
        paths: {
          "/docs": {
            get: {
              responses: {
                "200": {
                  description: 'Use $ref to reference other schemas',
                  content: {
                    "application/json": {
                      schema: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      });

      expect(spec.title).toBe("Ref In Desc");
      expect(spec.paths.length).toBe(1);
    });
  });

  describe("Issue 3: no node:module in build output (via externalized deps)", () => {
    it("openapi build has no node:module references", () => {
      const content = readDist("dist/index.js");
      expect(content).not.toContain('from"node:module"');
    });

    it("faker build has no node:module references", () => {
      const content = readDist("../faker/dist/index.js");
      expect(content).not.toContain('from"node:module"');
    });
  });

  describe("Issue 4: loadSeed uses dynamic import for node:fs", () => {
    it("loadSeed is async", () => {
      expect(loadSeed.constructor.name).toBe("AsyncFunction");
    });

    it("loads seed from file path", async () => {
      const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const tmpDir = mkdtempSync(join(import.meta.dirname, ".tmp-seed-"));
      const seedFile = join(tmpDir, "items.json");
      writeFileSync(seedFile, JSON.stringify([{ id: 1, name: "Test" }]));

      try {
        const result = await loadSeed({ items: seedFile }, []);
        expect(result.get("items")).toEqual([{ id: 1, name: "Test" }]);
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it("loads inline array seed without touching fs", async () => {
      const data = [{ id: 1 }, { id: 2 }];
      const result = await loadSeed({ things: data }, []);
      expect(result.get("things")).toEqual(data);
    });

    it("throws on invalid JSON in seed file", async () => {
      const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const tmpDir = mkdtempSync(join(import.meta.dirname, ".tmp-seed-"));
      const seedFile = join(tmpDir, "bad.json");
      writeFileSync(seedFile, "not json {{{");

      try {
        await expect(loadSeed({ items: seedFile }, [])).rejects.toThrow(
          "contains invalid JSON",
        );
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it("throws when seed file is not a JSON array", async () => {
      const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const tmpDir = mkdtempSync(join(import.meta.dirname, ".tmp-seed-"));
      const seedFile = join(tmpDir, "obj.json");
      writeFileSync(seedFile, JSON.stringify({ not: "an array" }));

      try {
        await expect(loadSeed({ items: seedFile }, [])).rejects.toThrow(
          "must contain a JSON array",
        );
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it("throws on invalid seed count", async () => {
      await expect(
        loadSeed({ items: { count: -1 } as any }, []),
      ).rejects.toThrow("must be a non-negative integer");
    });

    it("throws when auto-generating without schema", async () => {
      await expect(
        loadSeed(
          { items: { count: 5 } },
          [{ name: "items", basePath: "/items", itemPath: "/items/:id", idParam: "id", operations: ["list"] }],
        ),
      ).rejects.toThrow("no schema found");
    });
  });

  describe("end-to-end: openapi plugin with inline spec (no node APIs)", () => {
    it("full CRUD lifecycle", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: {
            openapi: "3.0.3",
            info: { title: "Inline", version: "1.0.0" },
            paths: {
              "/widgets": {
                get: {
                  responses: {
                    "200": {
                      description: "OK",
                      content: {
                        "application/json": {
                          schema: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: { id: { type: "integer" }, name: { type: "string" } },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                post: {
                  requestBody: {
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: { name: { type: "string" } },
                        },
                      },
                    },
                  },
                  responses: {
                    "201": {
                      description: "Created",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            properties: { id: { type: "integer" }, name: { type: "string" } },
                          },
                        },
                      },
                    },
                  },
                },
              },
              "/widgets/{widgetId}": {
                get: {
                  parameters: [{ name: "widgetId", in: "path", required: true, schema: { type: "integer" } }],
                  responses: {
                    "200": {
                      description: "OK",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            properties: { id: { type: "integer" }, name: { type: "string" } },
                          },
                        },
                      },
                    },
                  },
                },
                put: {
                  parameters: [{ name: "widgetId", in: "path", required: true, schema: { type: "integer" } }],
                  requestBody: {
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: { name: { type: "string" } },
                        },
                      },
                    },
                  },
                  responses: {
                    "200": {
                      description: "Updated",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            properties: { id: { type: "integer" }, name: { type: "string" } },
                          },
                        },
                      },
                    },
                  },
                },
                delete: {
                  parameters: [{ name: "widgetId", in: "path", required: true, schema: { type: "integer" } }],
                  responses: { "204": { description: "Deleted" } },
                },
              },
            },
          },
        }),
      );

      // List — empty
      const list = await mock.handle("GET", "/widgets");
      expect(list.status).toBe(200);
      expect(list.body).toEqual([]);

      // Create
      const created = await mock.handle("POST", "/widgets", { body: { name: "Sprocket" } });
      expect(created.status).toBe(201);
      expect(created.body).toHaveProperty("name", "Sprocket");
      const id = (created.body as any).widgetId;

      // Read
      const read = await mock.handle("GET", `/widgets/${id}`);
      expect(read.status).toBe(200);
      expect(read.body).toHaveProperty("name", "Sprocket");

      // Update
      const updated = await mock.handle("PUT", `/widgets/${id}`, { body: { name: "Gear" } });
      expect(updated.status).toBe(200);
      expect(updated.body).toHaveProperty("name", "Gear");

      // Delete
      const deleted = await mock.handle("DELETE", `/widgets/${id}`);
      expect(deleted.status).toBe(204);

      // List — empty again
      const list2 = await mock.handle("GET", "/widgets");
      expect(list2.status).toBe(200);
      expect(list2.body).toEqual([]);
    });

    it("inline spec with inline seed data", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: {
            openapi: "3.0.3",
            info: { title: "Seeded", version: "1.0.0" },
            paths: {
              "/items": {
                get: {
                  responses: {
                    "200": {
                      description: "OK",
                      content: {
                        "application/json": {
                          schema: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: { id: { type: "integer" }, label: { type: "string" } },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                post: {
                  responses: {
                    "201": {
                      description: "Created",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            properties: { id: { type: "integer" }, label: { type: "string" } },
                          },
                        },
                      },
                    },
                  },
                },
              },
              "/items/{itemId}": {
                get: {
                  parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "integer" } }],
                  responses: {
                    "200": {
                      description: "OK",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            properties: { id: { type: "integer" }, label: { type: "string" } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          seed: {
            items: [
              { itemId: 1, label: "Alpha" },
              { itemId: 2, label: "Beta" },
            ],
          },
        }),
      );

      const list = await mock.handle("GET", "/items");
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(2);
    });
  });
});
