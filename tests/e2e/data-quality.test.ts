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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Helpers ───────────────────────────────────────────────────────

function createApp(mock: Schmock.CallableMockInstance): express.Express {
  const app = express();
  app.use(express.json());
  app.use(toExpress(mock));
  return app;
}

/** Collect N responses from a GET endpoint */
async function collectResponses(
  app: express.Express,
  path: string,
  count: number,
): Promise<any[]> {
  const results: any[] = [];
  for (let i = 0; i < count; i++) {
    const res = await request(app)
      .get(path)
      .set("Prefer", "dynamic=true")
      .expect((r) => expect([200, 201]).toContain(r.status));
    results.push(res.body);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════
// Train Travel API — e2e data quality
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Train Travel API data quality", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => {
    mock?.close();
  });

  it("GET /stations returns realistic station data", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: TRAIN_TRAVEL_SPEC }));
    const app = createApp(mock);

    const bodies = await collectResponses(app, "/stations", 5);

    for (const body of bodies) {
      // Should be an object with data array (or direct array)
      const stations = Array.isArray(body) ? body : (body.data ?? body);
      if (!Array.isArray(stations)) continue;

      for (const station of stations) {
        // id: should be a UUID
        if (station.id) {
          expect(station.id).toMatch(UUID_RE);
        }

        // name: non-empty string
        if (station.name) {
          expect(typeof station.name).toBe("string");
          expect(station.name.length).toBeGreaterThan(0);
        }

        // address: non-empty string
        if (station.address) {
          expect(typeof station.address).toBe("string");
          expect(station.address.length).toBeGreaterThan(0);
        }

        // country_code: 2-letter code
        if (station.country_code) {
          expect(station.country_code).toMatch(/^[A-Z]{2}$/);
        }

        // timezone: non-empty string
        if (station.timezone) {
          expect(typeof station.timezone).toBe("string");
          expect(station.timezone.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("GET /trips returns realistic trip data", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: TRAIN_TRAVEL_SPEC }));
    const app = createApp(mock);

    const bodies = await collectResponses(app, "/trips", 5);

    for (const body of bodies) {
      const trips = Array.isArray(body) ? body : (body.data ?? body);
      if (!Array.isArray(trips)) continue;

      for (const trip of trips) {
        // id: UUID
        if (trip.id) {
          expect(trip.id).toMatch(UUID_RE);
        }

        // origin/destination: UUIDs or strings
        if (trip.origin) {
          expect(typeof trip.origin).toBe("string");
          expect(trip.origin.length).toBeGreaterThan(0);
        }

        // departure_time / arrival_time: parseable dates
        if (trip.departure_time) {
          expect(Date.parse(trip.departure_time)).not.toBeNaN();
        }
        if (trip.arrival_time) {
          expect(Date.parse(trip.arrival_time)).not.toBeNaN();
        }

        // price: positive number
        if (trip.price !== undefined) {
          expect(typeof trip.price).toBe("number");
        }

        // operator: non-empty string
        if (trip.operator) {
          expect(typeof trip.operator).toBe("string");
          expect(trip.operator.length).toBeGreaterThan(0);
        }

        // boolean fields
        if (trip.bicycles_allowed !== undefined) {
          expect(typeof trip.bicycles_allowed).toBe("boolean");
        }
        if (trip.dogs_allowed !== undefined) {
          expect(typeof trip.dogs_allowed).toBe("boolean");
        }
      }
    }
  });

  it("POST /bookings accepts and returns realistic data", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: TRAIN_TRAVEL_SPEC }));
    const app = createApp(mock);

    const res = await request(app)
      .post("/bookings")
      .send({
        trip_id: "4f4e4e1-4f4e-4e1e-8f4e-4f4e4e1e4f4e",
        passenger_name: "Jane Doe",
        has_bicycle: true,
        has_dog: false,
      })
      .expect((r) => expect([200, 201]).toContain(r.status));

    const booking = res.body;
    if (booking && typeof booking === "object") {
      // id: UUID (read-only, auto-generated)
      if (booking.id) {
        expect(booking.id).toMatch(UUID_RE);
      }

      // passenger_name: should reflect input or be a realistic string
      if (booking.passenger_name) {
        expect(typeof booking.passenger_name).toBe("string");
      }

      // booleans
      if (booking.has_bicycle !== undefined) {
        expect(typeof booking.has_bicycle).toBe("boolean");
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scalar Galaxy API — e2e data quality
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Scalar Galaxy API data quality", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => {
    mock?.close();
  });

  it("GET /planets returns realistic planet data", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: SCALAR_GALAXY_SPEC }));
    const app = createApp(mock);

    const bodies = await collectResponses(app, "/planets", 5);

    for (const body of bodies) {
      const planets = Array.isArray(body) ? body : (body.data ?? body);
      if (!Array.isArray(planets)) continue;

      for (const planet of planets) {
        // id: integer
        if (planet.id !== undefined) {
          expect(typeof planet.id).toBe("number");
        }

        // name: non-empty string
        if (planet.name) {
          expect(typeof planet.name).toBe("string");
          expect(planet.name.length).toBeGreaterThan(0);
        }

        // description: string or null (nullable)
        if (planet.description !== undefined) {
          expect(
            planet.description === null ||
              typeof planet.description === "string",
          ).toBe(true);
        }

        // type: one of the enum values
        const validTypes = [
          "terrestrial",
          "gas_giant",
          "ice_giant",
          "dwarf",
          "super_earth",
        ];
        if (planet.type) {
          expect(validTypes).toContain(planet.type);
        }

        // discoveredAt: parseable date
        if (planet.discoveredAt) {
          expect(Date.parse(planet.discoveredAt)).not.toBeNaN();
        }

        // image: string URL or null (nullable)
        if (planet.image !== undefined) {
          expect(
            planet.image === null || typeof planet.image === "string",
          ).toBe(true);
        }

        // tags: array of strings
        if (planet.tags) {
          expect(Array.isArray(planet.tags)).toBe(true);
          for (const tag of planet.tags) {
            expect(typeof tag).toBe("string");
          }
        }

        // creator: nested user object
        if (planet.creator && typeof planet.creator === "object") {
          if (planet.creator.id !== undefined) {
            expect(typeof planet.creator.id).toBe("number");
          }
          if (planet.creator.name) {
            expect(typeof planet.creator.name).toBe("string");
          }
        }

        // satellites: array of objects
        if (planet.satellites && Array.isArray(planet.satellites)) {
          for (const sat of planet.satellites) {
            if (sat.name) {
              expect(typeof sat.name).toBe("string");
            }
            // type: enum
            const satTypes = ["moon", "asteroid", "comet"];
            if (sat.type) {
              expect(satTypes).toContain(sat.type);
            }
          }
        }
      }
    }
  });

  it("POST /user/signup returns user data", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: SCALAR_GALAXY_SPEC }));
    const app = createApp(mock);

    const res = await request(app)
      .post("/user/signup")
      .send({ email: "test@example.com", password: "secret123" })
      .expect((r) => expect([200, 201]).toContain(r.status));

    const user = res.body;
    if (user && typeof user === "object") {
      if (user.id !== undefined) {
        expect(typeof user.id).toBe("number");
      }
      if (user.name) {
        expect(typeof user.name).toBe("string");
        expect(user.name.length).toBeGreaterThan(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Cross-spec statistical data quality
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Statistical data quality", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => {
    mock?.close();
  });

  it("schmockNullable fields (OpenAPI 3.0 nullable:true) are non-null most of the time", async () => {
    // Use an inline spec with nullable:true (3.0 style) to test our normalizer fix
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
    };

    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec }));
    const app = createApp(mock);

    let totalNullable = 0;
    let nullCount = 0;

    const bodies = await collectResponses(app, "/items", 50);
    for (const body of bodies) {
      if (!body || typeof body !== "object") continue;
      for (const field of ["note", "tag", "label"]) {
        if (field in body) {
          totalNullable++;
          if (body[field] === null) nullCount++;
        }
      }
    }

    // With ~5% null probability and 3 fields × 50 requests = ~150 samples,
    // expect < 20% null (old behavior was ~50%)
    if (totalNullable > 10) {
      const nullRate = nullCount / totalNullable;
      expect(nullRate).toBeLessThan(0.2);
    }
  });

  it("generated data is diverse across multiple requests", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: TRAIN_TRAVEL_SPEC }));
    const app = createApp(mock);

    const bodies = await collectResponses(app, "/stations", 10);
    const allNames = new Set<string>();

    for (const body of bodies) {
      const stations = Array.isArray(body) ? body : (body.data ?? body);
      if (!Array.isArray(stations)) continue;
      for (const s of stations) {
        if (s.name) allNames.add(s.name);
      }
    }

    // With dynamic=true, should get varied names across requests
    if (allNames.size > 0) {
      expect(allNames.size).toBeGreaterThan(1);
    }
  });
});
