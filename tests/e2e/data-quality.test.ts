/// <reference path="../../packages/core/schmock.d.ts" />

import { resolve } from "node:path";
import { schmock } from "@schmock/core";
import { toExpress } from "@schmock/express";
import { openapi } from "@schmock/openapi";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

const FIXTURES = resolve(__dirname, "../../packages/openapi/src/__fixtures__");
const TRAIN_TRAVEL_SPEC = resolve(FIXTURES, "train-travel.yaml");
const SCALAR_GALAXY_SPEC = resolve(FIXTURES, "scalar-galaxy.yaml");
const STATISTICAL_FAKER_SEED = 42;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) throw new Error("Expected an object response");
}

function expectNonEmptyString(value: unknown): asserts value is string {
  expect(typeof value).toBe("string");
  if (typeof value !== "string") throw new Error("Expected a string");
  expect(value.length).toBeGreaterThan(0);
}

function expectWrappedCollection(body: unknown): unknown[] {
  expectRecord(body);
  const data = body.data;
  expect(Array.isArray(data)).toBe(true);
  if (!Array.isArray(data))
    throw new Error("Expected response.data to be an array");
  expect(data.length).toBeGreaterThan(0);
  return data;
}

function createApp(mock: Schmock.CallableMockInstance): express.Express {
  const app = express();
  app.use(express.json());
  app.use(toExpress(mock));
  return app;
}

async function collectResponses(
  app: express.Express,
  path: string,
  count: number,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await request(app)
      .get(path)
      .set("Prefer", "dynamic=true")
      .expect(200);
    results.push(response.body);
  }
  return results;
}

describe("E2E: Train Travel API data quality", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => mock?.close());

  it("GET /stations returns non-empty, well-formed station data", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: TRAIN_TRAVEL_SPEC }));
    const bodies = await collectResponses(createApp(mock), "/stations", 5);

    for (const body of bodies) {
      for (const stationValue of expectWrappedCollection(body)) {
        expectRecord(stationValue);
        expectNonEmptyString(stationValue.id);
        expect(stationValue.id).toMatch(UUID_RE);
        expectNonEmptyString(stationValue.name);
        expectNonEmptyString(stationValue.address);
        expectNonEmptyString(stationValue.country_code);
        expect(stationValue.country_code).toMatch(/^[A-Z]{2}$/);
        if (stationValue.timezone !== undefined) {
          expectNonEmptyString(stationValue.timezone);
        }
      }
    }
  });

  it("GET /trips returns non-empty, well-formed trip data", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: TRAIN_TRAVEL_SPEC }));
    const bodies = await collectResponses(createApp(mock), "/trips", 5);

    for (const body of bodies) {
      for (const tripValue of expectWrappedCollection(body)) {
        expectRecord(tripValue);
        expectNonEmptyString(tripValue.id);
        expect(tripValue.id).toMatch(UUID_RE);
        expectNonEmptyString(tripValue.origin);
        expectNonEmptyString(tripValue.destination);
        expectNonEmptyString(tripValue.departure_time);
        expect(Date.parse(tripValue.departure_time)).not.toBeNaN();
        expectNonEmptyString(tripValue.arrival_time);
        expect(Date.parse(tripValue.arrival_time)).not.toBeNaN();
        expect(typeof tripValue.price).toBe("number");
        expectNonEmptyString(tripValue.operator);
        expect(typeof tripValue.bicycles_allowed).toBe("boolean");
        expect(typeof tripValue.dogs_allowed).toBe("boolean");
      }
    }
  });

  it("POST /bookings returns the submitted booking data", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: TRAIN_TRAVEL_SPEC }));
    const submitted = {
      trip_id: "4f4e4e1-4f4e-4e1e-8f4e-4f4e4e1e4f4e",
      passenger_name: "Jane Doe",
      has_bicycle: true,
      has_dog: false,
    };

    const response = await request(createApp(mock))
      .post("/bookings")
      .send(submitted)
      .expect(201);

    expectRecord(response.body);
    expect(response.body).toMatchObject(submitted);
    if (response.body.id !== undefined) {
      expectNonEmptyString(response.body.id);
      expect(response.body.id).toMatch(UUID_RE);
    }
  });
});

describe("E2E: Scalar Galaxy API data quality", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => mock?.close());

  it("GET /planets returns non-empty, well-formed planet data", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: SCALAR_GALAXY_SPEC }));
    const bodies = await collectResponses(createApp(mock), "/planets", 5);
    const planetTypes = [
      "terrestrial",
      "gas_giant",
      "ice_giant",
      "dwarf",
      "super_earth",
    ];

    for (const body of bodies) {
      for (const planetValue of expectWrappedCollection(body)) {
        expectRecord(planetValue);
        expect(typeof planetValue.id).toBe("number");
        expectNonEmptyString(planetValue.name);

        if (planetValue.description !== undefined) {
          expect(
            planetValue.description === null ||
              typeof planetValue.description === "string",
          ).toBe(true);
        }
        if (planetValue.type !== undefined) {
          expect(planetTypes).toContain(planetValue.type);
        }
        if (planetValue.discoveredAt !== undefined) {
          expectNonEmptyString(planetValue.discoveredAt);
          expect(Date.parse(planetValue.discoveredAt)).not.toBeNaN();
        }
        if (planetValue.tags !== undefined) {
          expect(Array.isArray(planetValue.tags)).toBe(true);
          if (!Array.isArray(planetValue.tags)) {
            throw new Error("Expected planet tags to be an array");
          }
          for (const tag of planetValue.tags) expect(typeof tag).toBe("string");
        }
        if (planetValue.creator !== undefined) {
          expectRecord(planetValue.creator);
        }
        if (planetValue.satellites !== undefined) {
          expect(Array.isArray(planetValue.satellites)).toBe(true);
          if (!Array.isArray(planetValue.satellites)) {
            throw new Error("Expected satellites to be an array");
          }
          for (const satelliteValue of planetValue.satellites) {
            expectRecord(satelliteValue);
            expectNonEmptyString(satelliteValue.name);
          }
        }
      }
    }
  });

  it("POST /user/signup returns generated user data", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: SCALAR_GALAXY_SPEC }));

    const response = await request(createApp(mock))
      .post("/user/signup")
      .send({ email: "test@example.com", password: "secret123" })
      .expect(201);

    expectRecord(response.body);
    expect(typeof response.body.id).toBe("number");
    expectNonEmptyString(response.body.name);
  });
});

describe("E2E: Statistical data quality", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => mock?.close());

  it("nullable fields are non-null most of the time", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Nullable Test", version: "1.0.0" },
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
                      minItems: 50,
                      maxItems: 50,
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          note: { type: "string", nullable: true },
                          tag: { type: "string", nullable: true },
                          label: { type: "string", nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec, fakerSeed: STATISTICAL_FAKER_SEED }));
    const bodies = await collectResponses(createApp(mock), "/items", 2);
    expect(bodies[1]).toEqual(bodies[0]);
    const body = bodies[0];
    if (!Array.isArray(body)) {
      throw new Error("Expected nullable response body to be an array");
    }
    expect(body).toHaveLength(50);
    let sampleCount = 0;
    let nullCount = 0;

    for (const item of body) {
      expectRecord(item);
      for (const field of ["note", "tag", "label"]) {
        if (field in item) {
          sampleCount += 1;
          if (item[field] === null) nullCount += 1;
        }
      }
    }

    expect(sampleCount).toBe(150);
    expect(nullCount).toBe(8);
  });

  it("dynamic generation produces diverse station names", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: TRAIN_TRAVEL_SPEC,
        fakerSeed: STATISTICAL_FAKER_SEED,
      }),
    );
    const bodies = await collectResponses(createApp(mock), "/stations", 2);
    expect(bodies[1]).toEqual(bodies[0]);
    const names = new Set<string>();

    for (const stationValue of expectWrappedCollection(bodies[0])) {
      expectRecord(stationValue);
      expectNonEmptyString(stationValue.name);
      names.add(stationValue.name);
    }

    expect(names.size).toBeGreaterThan(1);
  });
});
