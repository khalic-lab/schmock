/// <reference path="../../core/schmock.d.ts" />

import {
  ResourceLimitError,
  SchemaGenerationError,
  type SchmockError,
} from "@schmock/core";
import { generateFromSchema } from "@schmock/faker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStaticGenerator } from "./generators.js";
import type { ParsedPath } from "./parser.js";

// Mock @schmock/faker to force schema generation failures
vi.mock("@schmock/faker", () => ({
  generateFromSchema: vi.fn(),
}));

const generateFromSchemaMock = vi.mocked(generateFromSchema);

function makeParsedPath(overrides: Partial<ParsedPath> = {}): ParsedPath {
  return {
    path: "/test",
    method: "GET",
    parameters: [],
    responses: new Map([
      [
        200,
        {
          schema: { type: "object", properties: { id: { type: "number" } } },
          description: "OK",
        },
      ],
    ]),
    tags: [],
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<Schmock.RequestContext> = {},
): Schmock.RequestContext {
  return {
    path: "/test",
    method: "GET",
    params: {},
    query: {},
    headers: {},
    state: {},
    ...overrides,
  } as Schmock.RequestContext;
}

describe("generators — schema failure semantics", () => {
  beforeEach(() => {
    generateFromSchemaMock.mockReset();
  });

  it("throws a coded SchemaGenerationError naming the route", async () => {
    generateFromSchemaMock.mockRejectedValue(new Error("Schema too deep"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const generator = createStaticGenerator(makeParsedPath());

    // A laundered `[200, {}]` used to hide a broken contract behind a declared
    // success. Core renders this throw as a structured 500 instead.
    await expect(generator(makeContext())).rejects.toThrow(
      SchemaGenerationError,
    );
    await expect(generator(makeContext())).rejects.toThrow(
      /Schema generation failed for route GET \/test/,
    );
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("carries the SCHEMA_GENERATION_ERROR code and the original cause", async () => {
    const cause = new Error("Schema too deep");
    generateFromSchemaMock.mockRejectedValue(cause);

    const generator = createStaticGenerator(
      makeParsedPath({ path: "/users", method: "POST" }),
    );

    const error = await generator(
      makeContext({ path: "/users", method: "POST" }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(SchemaGenerationError);
    expect((error as SchmockError).code).toBe("SCHEMA_GENERATION_ERROR");
    expect((error as Error).message).toContain("POST /users");
    expect((error as Error).message).toContain("Schema too deep");
  });

  it("rethrows a SchmockError from faker with its own code intact", async () => {
    generateFromSchemaMock.mockRejectedValue(
      new ResourceLimitError("schema_nesting_depth", 10, 11),
    );

    const generator = createStaticGenerator(makeParsedPath());

    const error = await generator(makeContext()).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Wrapping it would launder RESOURCE_LIMIT_ERROR into a generic code.
    expect(error).toBeInstanceOf(ResourceLimitError);
    expect((error as SchmockError).code).toBe("RESOURCE_LIMIT_ERROR");
  });
});
