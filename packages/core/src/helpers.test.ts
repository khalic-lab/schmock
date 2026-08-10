import { describe, expect, it } from "vitest";
import {
  badRequest,
  created,
  forbidden,
  noContent,
  notFound,
  paginate,
  serverError,
  unauthorized,
} from "./helpers.js";

describe("notFound", () => {
  it("returns 404 with default message", () => {
    expect(notFound()).toEqual([404, { message: "Not Found" }]);
  });
  it("returns 404 with custom string message", () => {
    expect(notFound("User not found")).toEqual([
      404,
      { message: "User not found" },
    ]);
  });
  it("returns 404 with custom object", () => {
    expect(notFound({ code: "NOT_FOUND", detail: "gone" })).toEqual([
      404,
      { code: "NOT_FOUND", detail: "gone" },
    ]);
  });
});

describe("badRequest", () => {
  it("returns 400 with default message", () => {
    expect(badRequest()).toEqual([400, { message: "Bad Request" }]);
  });
  it("returns 400 with custom string", () => {
    expect(badRequest("Invalid email")).toEqual([
      400,
      { message: "Invalid email" },
    ]);
  });
});

describe("unauthorized", () => {
  it("returns 401 with default message", () => {
    expect(unauthorized()).toEqual([401, { message: "Unauthorized" }]);
  });
});

describe("forbidden", () => {
  it("returns 403 with default message", () => {
    expect(forbidden()).toEqual([403, { message: "Forbidden" }]);
  });
});

describe("serverError", () => {
  it("returns 500 with default message", () => {
    expect(serverError()).toEqual([500, { message: "Internal Server Error" }]);
  });
});

describe("created", () => {
  it("returns 201 with body", () => {
    expect(created({ id: 1, name: "John" })).toEqual([
      201,
      { id: 1, name: "John" },
    ]);
  });
});

describe("noContent", () => {
  it("returns 204 with null body", () => {
    expect(noContent()).toEqual([204, null]);
  });
});

describe("paginate", () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];

  it("returns first page with default pageSize", () => {
    const result = paginate(items);
    expect(result).toEqual({
      data: items,
      page: 1,
      pageSize: 10,
      total: 5,
      totalPages: 1,
    });
  });

  it("paginates correctly with custom options", () => {
    const result = paginate(items, { page: 2, pageSize: 2 });
    expect(result).toEqual({
      data: [{ id: 3 }, { id: 4 }],
      page: 2,
      pageSize: 2,
      total: 5,
      totalPages: 3,
    });
  });

  it("returns empty data for page beyond range", () => {
    const result = paginate(items, { page: 10, pageSize: 2 });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(5);
  });

  it("page=0 is normalized to page 1", () => {
    const result = paginate(items, { page: 0, pageSize: 2 });
    expect(result.page).toBe(1);
    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("pageSize=0 is normalized to the default 10", () => {
    const result = paginate(items, { pageSize: 0 });
    expect(result.pageSize).toBe(10);
    expect(result.data).toEqual(items);
  });

  it("handles empty array", () => {
    const result = paginate([], { page: 1, pageSize: 5 });
    expect(result).toEqual({
      data: [],
      page: 1,
      pageSize: 5,
      total: 0,
      totalPages: 0,
    });
  });

  it("normalizes a negative page to the first page", () => {
    const result = paginate(items, { page: -1, pageSize: 2 });
    expect(result).toEqual({
      data: [{ id: 1 }, { id: 2 }],
      page: 1,
      pageSize: 2,
      total: 5,
      totalPages: 3,
    });
  });

  it("normalizes a negative pageSize to the default", () => {
    const result = paginate(items, { page: 1, pageSize: -5 });
    expect(result.data).toEqual(items);
    expect(result.pageSize).toBe(10);
    expect(result.totalPages).toBe(1);
  });

  it("normalizes fractional page and pageSize", () => {
    const result = paginate(items, { page: 1.5, pageSize: 2.5 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
    expect(result.data).toEqual(items);
  });

  it("normalizes NaN and Infinity", () => {
    const nan = paginate(items, { page: Number.NaN, pageSize: Number.NaN });
    expect(nan.page).toBe(1);
    expect(nan.pageSize).toBe(10);

    const infinite = paginate(items, {
      page: Number.POSITIVE_INFINITY,
      pageSize: Number.POSITIVE_INFINITY,
    });
    expect(infinite.page).toBe(1);
    expect(infinite.pageSize).toBe(10);
    expect(infinite.totalPages).toBe(1);
  });

  it("never reports a negative or fractional totalPages", () => {
    for (const pageSize of [-5, 0, 2.5, Number.NaN]) {
      const result = paginate(items, { pageSize });
      expect(Number.isInteger(result.totalPages)).toBe(true);
      expect(result.totalPages).toBeGreaterThanOrEqual(0);
    }
  });
});
