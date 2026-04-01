// Meta-package should provide core + all plugins (no framework adapters)
import {
  schmock,
  notFound,
  badRequest,
  created,
  noContent,
  paginate,
  serverError,
  unauthorized,
  forbidden,
} from "@schmock/schmock";

// Verify schmock works
const mock = schmock();
mock("GET /test", [{ ok: true }]);
const res = await mock.handle("GET", "/test");
if (res.status !== 200) throw new Error("Status: " + res.status);

// Verify all helpers are re-exported
const checks = [
  notFound(), badRequest(), unauthorized(), forbidden(),
  serverError(), created({ id: 1 }), noContent(),
];
if (checks.length !== 7) throw new Error("Missing helpers");

// Verify paginate works
const p = paginate([1, 2, 3], { page: 1, pageSize: 2 });
if (p.data.length !== 2) throw new Error("paginate broken");

// Verify plugins are installable (they come as transitive deps)
const { fakerPlugin } = await import("@schmock/faker");
if (typeof fakerPlugin !== "function") throw new Error("faker not available");

const { openapi } = await import("@schmock/openapi");
if (typeof openapi !== "function") throw new Error("openapi not available");

console.log("@schmock/schmock: all checks passed");
