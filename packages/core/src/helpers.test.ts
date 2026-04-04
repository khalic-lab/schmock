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

  it("page=0 falls back to page 1 (falsy default)", () => {
    const result = paginate(items, { page: 0, pageSize: 2 });
    // page=0 is falsy, so options.page || 1 => 1
    expect(result.page).toBe(1);
    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("pageSize=0 falls back to default 10 (falsy default)", () => {
    const result = paginate(items, { pageSize: 0 });
    // pageSize=0 is falsy, so options.pageSize || 10 => 10
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

  it("negative page produces empty data (start index < 0)", () => {
    const result = paginate(items, { page: -1, pageSize: 2 });
    // (page - 1) * pageSize = (-1 - 1) * 2 = -4
    // items.slice(-4, -2) => items from index 1 to 3
    expect(result.page).toBe(-1);
    expect(result.pageSize).toBe(2);
    expect(result.total).toBe(5);
  });

  it("negative pageSize returns empty data", () => {
    const result = paginate(items, { page: 1, pageSize: -5 });
    // start = 0, end = 0 + (-5) = -5 => items.slice(0, -5) => []
    expect(result.data).toEqual([]);
    expect(result.pageSize).toBe(-5);
  });
});
