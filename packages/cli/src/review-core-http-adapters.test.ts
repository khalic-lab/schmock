import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliServer, createCliServer } from "./cli";

const petSchema = {
  type: "object",
  required: ["name"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
  },
};

const spec = {
  openapi: "3.0.3",
  info: { title: "forms", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "list",
            content: {
              "application/json": {
                schema: { type: "array", items: petSchema },
              },
            },
          },
        },
      },
      post: {
        requestBody: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": { schema: petSchema },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: { "application/json": { schema: petSchema } },
          },
        },
      },
    },
    "/pets/{id}": {
      get: {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": {
            description: "one",
            content: { "application/json": { schema: petSchema } },
          },
        },
      },
    },
    "/upload": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        responses: { "204": { description: "stored" } },
      },
    },
  },
};

describe("CLI request bodies match the fetch interceptor", () => {
  let dir: string;
  let server: CliServer | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "schmock-cli-bodies-"));
    writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(): Promise<string> {
    server = await createCliServer({
      spec: join(dir, "spec.json"),
      port: 0,
      errors: true,
    });
    return `http://127.0.0.1:${server.port}`;
  }

  it("validates and stores a urlencoded form post under --errors", async () => {
    const base = await start();

    const created = await fetch(`${base}/pets`, {
      method: "POST",
      body: new URLSearchParams({ name: "Rex" }),
    });

    expect(created.status).toBe(201);
    const pet: unknown = await created.json();
    expect(pet).toMatchObject({ name: "Rex" });
    const id =
      typeof pet === "object" && pet !== null && "id" in pet
        ? pet.id
        : undefined;
    const stored = await fetch(`${base}/pets/${String(id)}`);
    await expect(stored.json()).resolves.toMatchObject({ name: "Rex" });
  });

  it("accepts a binary upload for a format: binary body under --errors", async () => {
    const base = await start();

    const response = await fetch(`${base}/upload`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd8, 0x00]),
    });

    expect(response.status).toBe(204);
  });
});
