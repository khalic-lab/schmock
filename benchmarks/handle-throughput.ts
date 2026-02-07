/// <reference path="../types/schmock.d.ts" />

import { schmock } from "../packages/core/src/index";

async function benchmark(name: string, fn: () => Promise<void>, iterations: number) {
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

  console.log(`  ${name}: ${opsPerSec.toLocaleString()} ops/sec (${avgMs}ms avg, ${iterations} iterations)`);
}

async function run() {
  console.log("Schmock handle() throughput benchmark\n");
  const iterations = 10_000;

  // 1. Simple static response
  console.log("Static responses:");
  const staticMock = schmock();
  staticMock("GET /hello", "Hello World");
  await benchmark("Plain text", () => staticMock.handle("GET", "/hello"), iterations);

  const jsonMock = schmock();
  jsonMock("GET /users", [{ id: 1, name: "John" }]);
  await benchmark("JSON array", () => jsonMock.handle("GET", "/users"), iterations);

  // 2. Generator function responses
  console.log("\nGenerator functions:");
  const genMock = schmock();
  genMock("GET /dynamic", () => ({ timestamp: Date.now() }));
  await benchmark("Simple generator", () => genMock.handle("GET", "/dynamic"), iterations);

  const stateMock = schmock({ state: { count: 0 } });
  stateMock("POST /increment", ({ state }) => {
    (state as any).count++;
    return { count: (state as any).count };
  });
  await benchmark("Stateful generator", () => stateMock.handle("POST", "/increment"), iterations);

  // 3. Path parameters
  console.log("\nPath parameters:");
  const paramMock = schmock();
  paramMock("GET /users/:id", ({ params }) => ({ id: params.id }));
  await benchmark("Single param", () => paramMock.handle("GET", "/users/42"), iterations);

  const multiParamMock = schmock();
  multiParamMock("GET /users/:userId/posts/:postId", ({ params }) => params);
  await benchmark("Multiple params", () => multiParamMock.handle("GET", "/users/1/posts/99"), iterations);

  // 4. Namespace handling
  console.log("\nNamespace:");
  const nsMock = schmock({ namespace: "/api/v1" });
  nsMock("GET /users", [{ id: 1 }]);
  await benchmark("With namespace", () => nsMock.handle("GET", "/api/v1/users"), iterations);

  // 5. Query parameters
  console.log("\nQuery parameters:");
  const queryMock = schmock();
  queryMock("GET /search", ({ query }) => ({ q: query.q }));
  await benchmark("With query", () => queryMock.handle("GET", "/search", { query: { q: "test" } }), iterations);

  // 6. Many routes (route lookup performance)
  console.log("\nRoute lookup (50 routes):");
  const manyRoutesMock = schmock();
  for (let i = 0; i < 50; i++) {
    manyRoutesMock(`GET /route-${i}` as any, { id: i });
  }
  await benchmark("First route", () => manyRoutesMock.handle("GET", "/route-0"), iterations);
  await benchmark("Last route", () => manyRoutesMock.handle("GET", "/route-49"), iterations);
  await benchmark("404 (no match)", () => manyRoutesMock.handle("GET", "/nonexistent"), iterations);

  // 7. History recording overhead
  console.log("\nHistory recording overhead:");
  const histMock = schmock();
  histMock("GET /tracked", "ok");
  // Make requests then measure with accumulated history
  for (let i = 0; i < 1000; i++) {
    await histMock.handle("GET", "/tracked");
  }
  await benchmark("With 1000 history entries", () => histMock.handle("GET", "/tracked"), iterations);

  console.log("\nDone.");
}

run().catch(console.error);
