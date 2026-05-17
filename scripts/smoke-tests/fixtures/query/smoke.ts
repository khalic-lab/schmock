import { schmock } from "@schmock/core";
import { queryPlugin } from "@schmock/query";

const items = Array.from({ length: 25 }, (_, i) => ({
  id: i + 1,
  name: `Item ${i + 1}`,
  category: i % 2 === 0 ? "a" : "b",
}));

const mock = schmock();
mock("GET /items", () => items).pipe(
  queryPlugin({
    pagination: { defaultLimit: 10, maxLimit: 50 },
    sorting: { allowed: ["id", "name"], default: "id" },
    filtering: { allowed: ["category"] },
  }),
);

// Pagination
const p1 = await mock.handle("GET", "/items", { query: { page: "2", limit: "5" } });
if (p1.status !== 200) throw new Error("Status: " + p1.status);
const body1 = p1.body as { data: unknown[]; pagination: { page: number; total: number } };
if (body1.data.length !== 5) throw new Error("Page size: " + body1.data.length);
if (body1.pagination.total !== 25) throw new Error("Total: " + body1.pagination.total);
if (body1.pagination.page !== 2) throw new Error("Page: " + body1.pagination.page);

// Filtering
const p2 = await mock.handle("GET", "/items", {
  query: { "filter[category]": "a" },
});
const body2 = p2.body as { data: Array<{ category: string }>; pagination: { total: number } };
if (body2.pagination.total !== 13)
  throw new Error("Filtered total: " + body2.pagination.total);
if (body2.data.some((it) => it.category !== "a"))
  throw new Error("Filter leaked non-'a' rows");

// Sorting desc
const p3 = await mock.handle("GET", "/items", {
  query: { sort: "id", order: "desc", limit: "3" },
});
const body3 = p3.body as { data: Array<{ id: number }> };
if (body3.data[0].id !== 25 || body3.data[2].id !== 23)
  throw new Error("Sort desc: " + JSON.stringify(body3.data.map((d) => d.id)));

console.log("@schmock/query: all checks passed");
