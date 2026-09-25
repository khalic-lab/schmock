/// <reference path="../packages/core/schmock.d.ts" />

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schmock } from "../packages/core/src/index";

/**
 * Manual throughput benchmark (`bun run bench`). It prints numbers and has no
 * thresholds, so it is not a gate: it runs neither in CI nor in the pre-commit
 * hook. It exits non-zero only when a scenario throws.
 */

async function benchmark(
  name: string,
  fn: () => Promise<unknown>,
  iterations: number,
) {
  // Warmup
  for (let i = 0; i < 100; i++) {
    await fn();
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
  const elapsed = performance.now() - start;
  const opsPerSec = Math.round((iterations / elapsed) * 1000);
  const avgMs = (elapsed / iterations).toFixed(4);

  console.log(
    `  ${name}: ${opsPerSec.toLocaleString()} ops/sec (${avgMs}ms avg, ${iterations} iterations)`,
  );
}

/**
 * A mock with `routeCount` param routes (`GET /r<i>/:id`), plus a path that
 * hits the LAST one and a path that matches none.
 *
 * Static routes resolve through an O(1) map before the param scan runs, so a
 * static-only route table never measures lookup cost. Both paths here force
 * the linear scan over every param route.
 */
export function createParamRouteLookup(routeCount: number): {
  mock: Schmock.CallableMockInstance;
  lastRoutePath: string;
  missPath: string;
} {
  const mock = schmock();
  for (let i = 0; i < routeCount; i++) {
    const route = i;
    mock(`GET /r${i}/:id`, ({ params }) => ({ route, id: params.id }));
  }
  return {
    mock,
    lastRoutePath: `/r${routeCount - 1}/last`,
    missPath: `/r${routeCount}/none`,
  };
}

/** A JSON body of `items` records, big enough for serialization to show. */
function largeBody(
  items: number,
): Array<{ id: number; name: string; tags: string[] }> {
  return Array.from({ length: items }, (_, id) => ({
    id,
    name: `item-${id}`,
    tags: ["alpha", "beta", "gamma"],
  }));
}

async function run() {
  console.log("Schmock handle() throughput benchmark\n");
  const iterations = 10_000;

  // 1. Simple static response
  console.log("Static responses:");
  const staticMock = schmock();
  staticMock("GET /hello", "Hello World");
  await benchmark(
    "Plain text",
    () => staticMock.handle("GET", "/hello"),
    iterations,
  );

  const jsonMock = schmock();
  jsonMock("GET /users", [{ id: 1, name: "John" }]);
  await benchmark(
    "JSON array",
    () => jsonMock.handle("GET", "/users"),
    iterations,
  );

  // 2. Generator function responses
  console.log("\nGenerator functions:");
  const genMock = schmock();
  genMock("GET /dynamic", () => ({ timestamp: Date.now() }));
  await benchmark(
    "Simple generator",
    () => genMock.handle("GET", "/dynamic"),
    iterations,
  );

  const stateMock = schmock({ state: { count: 0 } });
  stateMock("POST /increment", ({ state }) => {
    const count = (typeof state.count === "number" ? state.count : 0) + 1;
    state.count = count;
    return { count };
  });
  await benchmark(
    "Stateful generator",
    () => stateMock.handle("POST", "/increment"),
    iterations,
  );

  // 3. Path parameters
  console.log("\nPath parameters:");
  const paramMock = schmock();
  paramMock("GET /users/:id", ({ params }) => ({ id: params.id }));
  await benchmark(
    "Single param",
    () => paramMock.handle("GET", "/users/42"),
    iterations,
  );

  const multiParamMock = schmock();
  multiParamMock("GET /users/:userId/posts/:postId", ({ params }) => params);
  await benchmark(
    "Multiple params",
    () => multiParamMock.handle("GET", "/users/1/posts/99"),
    iterations,
  );

  // 4. Namespace handling
  console.log("\nNamespace:");
  const nsMock = schmock({ namespace: "/api/v1" });
  nsMock("GET /users", [{ id: 1 }]);
  await benchmark(
    "With namespace",
    () => nsMock.handle("GET", "/api/v1/users"),
    iterations,
  );

  // 5. Query parameters
  console.log("\nQuery parameters:");
  const queryMock = schmock();
  queryMock("GET /search", ({ query }) => ({ q: query.q }));
  await benchmark(
    "With query",
    () => queryMock.handle("GET", "/search", { query: { q: "test" } }),
    iterations,
  );

  // 6. Static route lookup. Static routes hit an O(1) map, so first, last and
  // miss should all cost the same; this is a baseline, not a scan test.
  console.log("\nStatic route lookup (50 routes, O(1) map):");
  const manyRoutesMock = schmock();
  for (let i = 0; i < 50; i++) {
    manyRoutesMock(`GET /route-${i}`, { id: i });
  }
  await benchmark(
    "First route",
    () => manyRoutesMock.handle("GET", "/route-0"),
    iterations,
  );
  await benchmark(
    "Last route",
    () => manyRoutesMock.handle("GET", "/route-49"),
    iterations,
  );
  await benchmark(
    "404 (no match)",
    () => manyRoutesMock.handle("GET", "/nonexistent"),
    iterations,
  );

  // 7. Param route lookup. Param routes are scanned linearly, so the last
  // route and a miss both walk the whole table.
  for (const routeCount of [50, 500, 2000]) {
    console.log(`\nParam route scan (${routeCount} routes):`);
    const lookup = createParamRouteLookup(routeCount);
    const scanIterations = routeCount >= 2000 ? 1_000 : iterations;
    await benchmark(
      "Last route",
      () => lookup.mock.handle("GET", lookup.lastRoutePath),
      scanIterations,
    );
    await benchmark(
      "404 (no match)",
      () => lookup.mock.handle("GET", lookup.missPath),
      scanIterations,
    );
  }

  // 8. Large response bodies, with and without history recording
  console.log("\nLarge JSON body (1000 items):");
  const body = largeBody(1000);
  const defaultHistoryMock = schmock();
  defaultHistoryMock("GET /items", body);
  await benchmark(
    "Default history",
    () => defaultHistoryMock.handle("GET", "/items"),
    1_000,
  );
  const noHistoryMock = schmock({ maxHistorySize: 0 });
  noHistoryMock("GET /items", body);
  await benchmark(
    "maxHistorySize: 0",
    () => noHistoryMock.handle("GET", "/items"),
    1_000,
  );

  // 9. History recording overhead
  console.log("\nHistory recording overhead:");
  const histMock = schmock();
  histMock("GET /tracked", "ok");
  // Make requests then measure with accumulated history
  for (let i = 0; i < 1000; i++) {
    await histMock.handle("GET", "/tracked");
  }
  await benchmark(
    "With 1000 history entries",
    () => histMock.handle("GET", "/tracked"),
    iterations,
  );

  // 10. fetch() through intercept(), the path browser adapters take
  console.log("\nfetch() through intercept():");
  const interceptMock = schmock();
  interceptMock("GET /api/users/:id", ({ params }) => ({ id: params.id }));
  interceptMock("GET /api/items", body);
  const handle = interceptMock.intercept({
    baseUrl: "/api",
    passthrough: false,
  });
  try {
    await benchmark(
      "Small JSON",
      async () => (await fetch("http://localhost/api/users/7")).json(),
      iterations,
    );
    await benchmark(
      "Large JSON (1000 items)",
      async () => (await fetch("http://localhost/api/items")).json(),
      1_000,
    );
  } finally {
    handle.restore();
  }

  console.log("\nDone.");
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  run().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
