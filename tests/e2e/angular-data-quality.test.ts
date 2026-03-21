/// <reference path="../../packages/core/schmock.d.ts" />

// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import { resolve } from "node:path";
import {
  type HttpHandler,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import {
  createSchmockInterceptor,
  createSchmockInterceptorFromSpec,
} from "@schmock/angular";
import { schmock } from "@schmock/core";
import { openapi } from "@schmock/openapi";
import { of } from "rxjs";
import { describe, expect, it } from "vitest";

const FIXTURES = resolve(__dirname, "../../packages/openapi/src/__fixtures__");
const TRAIN_TRAVEL_SPEC = resolve(FIXTURES, "train-travel.yaml");
const SCALAR_GALAXY_SPEC = resolve(FIXTURES, "scalar-galaxy.yaml");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mockNext: HttpHandler = {
  handle: () => of(new HttpResponse({ body: "passthrough" })),
};

// ─── Helpers ───────────────────────────────────────────────────────

async function interceptRequest(
  interceptorClass: new () => any,
  method: string,
  path: string,
  body?: any,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const interceptor = new interceptorClass();
  let req = new HttpRequest(method, path, body ?? null);

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      req = req.clone({ setHeaders: { [key]: value } });
    }
  }

  return new Promise((resolve, reject) => {
    interceptor.intercept(req, mockNext).subscribe({
      next: (res: any) => {
        if (res instanceof HttpResponse) {
          if (res.body === "passthrough") {
            reject(
              new Error(
                `Route not matched: ${method} ${path} — got passthrough`,
              ),
            );
            return;
          }
          resolve({ status: res.status, body: res.body });
        }
      },
      error: (err: any) => reject(err),
    });
  });
}

/** Collect N responses from a GET endpoint */
async function collectResponses(
  interceptorClass: new () => any,
  path: string,
  count: number,
): Promise<any[]> {
  const results: any[] = [];
  for (let i = 0; i < count; i++) {
    const res = await interceptRequest(interceptorClass, "GET", path, null, {
      Prefer: "dynamic=true",
    });
    expect([200, 201]).toContain(res.status);
    results.push(res.body);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════
// Train Travel API — e2e data quality (Angular)
// ═══════════════════════════════════════════════════════════════════

describe("E2E Angular: Train Travel API data quality", () => {
  it("GET /stations returns realistic station data", async () => {
    const interceptor = await createSchmockInterceptorFromSpec({
      spec: TRAIN_TRAVEL_SPEC,
    });

    const bodies = await collectResponses(interceptor, "/stations", 5);

    for (const body of bodies) {
      const stations = Array.isArray(body) ? body : (body.data ?? body);
      if (!Array.isArray(stations)) continue;

      for (const station of stations) {
        if (station.id) {
          expect(station.id).toMatch(UUID_RE);
        }
        if (station.name) {
          expect(typeof station.name).toBe("string");
          expect(station.name.length).toBeGreaterThan(0);
        }
        if (station.address) {
          expect(typeof station.address).toBe("string");
          expect(station.address.length).toBeGreaterThan(0);
        }
        if (station.country_code) {
          expect(station.country_code).toMatch(/^[A-Z]{2}$/);
        }
        if (station.timezone) {
          expect(typeof station.timezone).toBe("string");
          expect(station.timezone.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("GET /trips returns realistic trip data", async () => {
    const interceptor = await createSchmockInterceptorFromSpec({
      spec: TRAIN_TRAVEL_SPEC,
    });

    const bodies = await collectResponses(interceptor, "/trips", 5);

    for (const body of bodies) {
      const trips = Array.isArray(body) ? body : (body.data ?? body);
      if (!Array.isArray(trips)) continue;

      for (const trip of trips) {
        if (trip.id) {
          expect(trip.id).toMatch(UUID_RE);
        }
        if (trip.origin) {
          expect(typeof trip.origin).toBe("string");
          expect(trip.origin.length).toBeGreaterThan(0);
        }
        if (trip.departure_time) {
          expect(Date.parse(trip.departure_time)).not.toBeNaN();
        }
        if (trip.arrival_time) {
          expect(Date.parse(trip.arrival_time)).not.toBeNaN();
        }
        if (trip.price !== undefined) {
          expect(typeof trip.price).toBe("number");
        }
        if (trip.operator) {
          expect(typeof trip.operator).toBe("string");
          expect(trip.operator.length).toBeGreaterThan(0);
        }
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
    const interceptor = await createSchmockInterceptorFromSpec({
      spec: TRAIN_TRAVEL_SPEC,
    });

    const res = await interceptRequest(interceptor, "POST", "/bookings", {
      trip_id: "4f4e4e1-4f4e-4e1e-8f4e-4f4e4e1e4f4e",
      passenger_name: "Jane Doe",
      has_bicycle: true,
      has_dog: false,
    });

    expect([200, 201]).toContain(res.status);

    const booking = res.body;
    if (booking && typeof booking === "object") {
      if (booking.id) {
        expect(booking.id).toMatch(UUID_RE);
      }
      if (booking.passenger_name) {
        expect(typeof booking.passenger_name).toBe("string");
      }
      if (booking.has_bicycle !== undefined) {
        expect(typeof booking.has_bicycle).toBe("boolean");
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scalar Galaxy API — e2e data quality (Angular)
// ═══════════════════════════════════════════════════════════════════

describe("E2E Angular: Scalar Galaxy API data quality", () => {
  it("GET /planets returns realistic planet data", async () => {
    const interceptor = await createSchmockInterceptorFromSpec({
      spec: SCALAR_GALAXY_SPEC,
    });

    const bodies = await collectResponses(interceptor, "/planets", 5);

    for (const body of bodies) {
      const planets = Array.isArray(body) ? body : (body.data ?? body);
      if (!Array.isArray(planets)) continue;

      for (const planet of planets) {
        if (planet.id !== undefined) {
          expect(typeof planet.id).toBe("number");
        }
        if (planet.name) {
          expect(typeof planet.name).toBe("string");
          expect(planet.name.length).toBeGreaterThan(0);
        }
        if (planet.description !== undefined) {
          expect(
            planet.description === null ||
              typeof planet.description === "string",
          ).toBe(true);
        }
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
        if (planet.discoveredAt) {
          expect(Date.parse(planet.discoveredAt)).not.toBeNaN();
        }
        if (planet.image !== undefined) {
          expect(
            planet.image === null || typeof planet.image === "string",
          ).toBe(true);
        }
        if (planet.tags) {
          expect(Array.isArray(planet.tags)).toBe(true);
          for (const tag of planet.tags) {
            expect(typeof tag).toBe("string");
          }
        }
        if (planet.creator && typeof planet.creator === "object") {
          if (planet.creator.id !== undefined) {
            expect(typeof planet.creator.id).toBe("number");
          }
          if (planet.creator.name) {
            expect(typeof planet.creator.name).toBe("string");
          }
        }
        if (planet.satellites && Array.isArray(planet.satellites)) {
          for (const sat of planet.satellites) {
            if (sat.name) {
              expect(typeof sat.name).toBe("string");
            }
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
    const interceptor = await createSchmockInterceptorFromSpec({
      spec: SCALAR_GALAXY_SPEC,
    });

    const res = await interceptRequest(interceptor, "POST", "/user/signup", {
      email: "test@example.com",
      password: "secret123",
    });

    expect([200, 201]).toContain(res.status);

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
// Cross-spec statistical data quality (Angular)
// ═══════════════════════════════════════════════════════════════════

describe("E2E Angular: Statistical data quality", () => {
  it("schmockNullable fields (OpenAPI 3.0 nullable:true) are non-null most of the time", async () => {
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

    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec }));
    const interceptorClass = createSchmockInterceptor(mock);

    let totalNullable = 0;
    let nullCount = 0;

    const bodies = await collectResponses(interceptorClass, "/items", 50);
    for (const body of bodies) {
      if (!body || typeof body !== "object") continue;
      for (const field of ["note", "tag", "label"]) {
        if (field in body) {
          totalNullable++;
          if (body[field] === null) nullCount++;
        }
      }
    }

    // With ~5% null probability and 3 fields x 50 requests = ~150 samples,
    // expect < 20% null (old behavior was ~50%)
    if (totalNullable > 10) {
      const nullRate = nullCount / totalNullable;
      expect(nullRate).toBeLessThan(0.2);
    }
  });

  it("generated data is diverse across multiple requests", async () => {
    const interceptor = await createSchmockInterceptorFromSpec({
      spec: TRAIN_TRAVEL_SPEC,
    });

    const bodies = await collectResponses(interceptor, "/stations", 10);
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
