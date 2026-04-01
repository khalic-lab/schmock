import {
  schmock,
  isRouteNotFound,
  notFound,
  badRequest,
  unauthorized,
  forbidden,
  serverError,
  created,
  noContent,
  paginate,
  ROUTE_NOT_FOUND_CODE,
} from "@schmock/core";

// 1. Response helpers
const checks = [
  ["notFound", notFound(), [404, { message: "Not Found" }]],
  ["badRequest", badRequest("oops"), [400, { message: "oops" }]],
  ["unauthorized", unauthorized(), [401, { message: "Unauthorized" }]],
  ["forbidden", forbidden(), [403, { message: "Forbidden" }]],
  ["serverError", serverError(), [500, { message: "Internal Server Error" }]],
  ["created", created({ id: 1 }), [201, { id: 1 }]],
  ["noContent", noContent(), [204, null]],
] as const;

for (const [name, actual, expected] of checks) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// 2. Paginate
const page = paginate([1, 2, 3, 4, 5], { page: 2, pageSize: 2 });
if (page.data[0] !== 3 || page.totalPages !== 3) throw new Error("paginate failed");

// 3. isRouteNotFound
if (!isRouteNotFound({ status: 404, body: { code: ROUTE_NOT_FOUND_CODE }, headers: {} })) {
  throw new Error("isRouteNotFound should return true");
}
if (isRouteNotFound({ status: 404, body: { message: "gone" }, headers: {} })) {
  throw new Error("isRouteNotFound should return false for regular 404");
}

// 4. mock.handle()
const mock = schmock();
mock("GET /api/users", [{ id: 1, name: "Alice" }]);
mock("POST /api/users", ({ body }) => [201, body]);
mock("GET /api/users/:id", ({ params }) => ({ id: Number(params.id), name: "User " + params.id }));

const r1 = await mock.handle("GET", "/api/users");
if (r1.status !== 200) throw new Error("GET /api/users status: " + r1.status);

const r2 = await mock.handle("POST", "/api/users", { body: { name: "Bob" } });
if (r2.status !== 201) throw new Error("POST status: " + r2.status);

const r3 = await mock.handle("GET", "/api/users/42");
const body = r3.body as { id: number; name: string };
if (body.id !== 42) throw new Error("Param route failed");

// 5. mock.intercept()
const mock2 = schmock();
mock2("GET /api/items", [{ id: 1 }]);
const handle = mock2.intercept();

const res = await fetch("http://localhost/api/items");
if (res.status !== 200) throw new Error("intercept status: " + res.status);
const items = await res.json();
if (items[0].id !== 1) throw new Error("intercept body wrong");

handle.restore();
if (handle.active) throw new Error("should be inactive after restore");

// 6. Spy API
if (!mock.called("GET", "/api/users")) throw new Error("spy: should be called");
if (mock.callCount() !== 3) throw new Error("spy: expected 3 calls, got " + mock.callCount());

console.log("@schmock/core: all checks passed");
