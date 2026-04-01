# Adapter Refactor + React/Vue Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract shared adapter primitives into core (response helpers, `isRouteNotFound`, `mock.intercept()`), refactor Express/Angular adapters to use them, then build `@schmock/react` and `@schmock/vue` adapters.

**Architecture:** Core gains three primitives — response helpers, a route-not-found detection utility, and a fetch interceptor (`mock.intercept()`). Each framework adapter owns its facade: converting framework-specific types to/from core primitives. React and Vue adapters wrap `mock.intercept()` with framework-idiomatic APIs (Provider/hooks, Plugin/composables).

**Tech Stack:** TypeScript 6.0, Bun workspaces, Vitest + @amiceli/vitest-cucumber for BDD, Biome for linting, React 18+/19+, Vue 3.

---

## File Structure

### Core changes (`packages/core/`)
- Create: `src/helpers.ts` — response helpers (notFound, created, paginate, etc.)
- Create: `src/helpers.test.ts` — unit tests for helpers
- Create: `src/interceptor.ts` — fetch interceptor implementation
- Create: `src/interceptor.test.ts` — unit tests for interceptor
- Create: `src/steps/interceptor.steps.ts` — BDD step definitions
- Modify: `src/constants.ts` — add `isRouteNotFound()` utility
- Modify: `src/constants.test.ts` — add tests for `isRouteNotFound()`
- Modify: `src/builder.ts` — add `intercept()` method
- Modify: `src/index.ts` — export new modules, wire `intercept` on callable instance
- Modify: `schmock.d.ts` — add new types (AdapterRequest, InterceptOptions, etc.)

### Feature files (`features/`)
- Create: `features/fetch-interceptor.feature`
- Create: `features/react-adapter.feature`
- Create: `features/vue-adapter.feature`

### Express refactor (`packages/express/`)
- Modify: `src/index.ts` — use `isRouteNotFound` from core

### Angular refactor (`packages/angular/`)
- Modify: `src/index.ts` — use `isRouteNotFound` from core, replace helpers with re-exports from core

### Meta-package (`packages/schmock/`)
- Modify: `package.json` — remove `@schmock/express` and `@schmock/angular` from dependencies
- Modify: `src/index.ts` — export response helpers from core

### New React adapter (`packages/react/`)
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.config.bdd.ts`
- Create: `src/index.ts` — Provider, useSchmock hook (no test-library dependency)
- Create: `src/testing.ts` — renderWithSchmock test utility (imports @testing-library/react)
- Create: `src/steps/react-adapter.steps.ts` — BDD step definitions

### New Vue adapter (`packages/vue/`)
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.config.bdd.ts`
- Create: `src/index.ts` — Plugin, useSchmock composable
- Create: `src/steps/vue-adapter.steps.ts` — BDD step definitions

### Build order update (`package.json` root)
- Modify: `package.json` — add `@schmock/react` and `@schmock/vue` to build + test scripts

---

## Phase 1: Core Primitives

### Task 1: Response Helpers Module

**Files:**
- Create: `packages/core/src/helpers.ts`
- Create: `packages/core/src/helpers.test.ts`
- Modify: `packages/core/schmock.d.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add types to schmock.d.ts**

Add after the `ServerInfo` interface (after line 382) in `packages/core/schmock.d.ts`:

```typescript
  // ===== Response Helpers =====

  interface PaginateOptions {
    page?: number;
    pageSize?: number;
  }

  interface PaginatedResponse<T> {
    data: T[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  }
```

- [ ] **Step 2: Write failing tests for response helpers**

Create `packages/core/src/helpers.test.ts`:

```typescript
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
    expect(notFound("User not found")).toEqual([404, { message: "User not found" }]);
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
    expect(badRequest("Invalid email")).toEqual([400, { message: "Invalid email" }]);
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
    expect(created({ id: 1, name: "John" })).toEqual([201, { id: 1, name: "John" }]);
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
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/core && bun vitest run src/helpers.test.ts`
Expected: FAIL — module `./helpers.js` not found.

- [ ] **Step 4: Implement response helpers**

Create `packages/core/src/helpers.ts`:

```typescript
/// <reference path="../schmock.d.ts" />

export function notFound(message: string | object = "Not Found"): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [404, body];
}

export function badRequest(message: string | object = "Bad Request"): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [400, body];
}

export function unauthorized(message: string | object = "Unauthorized"): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [401, body];
}

export function forbidden(message: string | object = "Forbidden"): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [403, body];
}

export function serverError(message: string | object = "Internal Server Error"): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [500, body];
}

export function created(body: object): [number, object] {
  return [201, body];
}

export function noContent(): [number, null] {
  return [204, null];
}

export function paginate<T>(
  items: T[],
  options: Schmock.PaginateOptions = {},
): Schmock.PaginatedResponse<T> {
  const page = options.page || 1;
  const pageSize = options.pageSize || 10;
  const total = items.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const data = items.slice(start, end);

  return { data, page, pageSize, total, totalPages };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && bun vitest run src/helpers.test.ts`
Expected: All 11 tests PASS.

- [ ] **Step 6: Export helpers from core index**

Add to `packages/core/src/index.ts` after the HTTP server helpers export block (after line 108):

```typescript
// Re-export response helpers
export {
  badRequest,
  created,
  forbidden,
  noContent,
  notFound,
  paginate,
  serverError,
  unauthorized,
} from "./helpers.js";
export type { PaginateOptions, PaginatedResponse } from "./types.js";
```

Also add the type re-exports to the existing type export block. Add `PaginateOptions` and `PaginatedResponse` to the `export type` block in `packages/core/src/types.ts` (or wherever the project sources its re-exported types from — if types come from `schmock.d.ts` ambient namespace, then the `export type` in index.ts should reference `./helpers.js` directly for the concrete types).

Note: Verify the build passes after adding exports. Run `cd packages/core && bun run build`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/helpers.ts packages/core/src/helpers.test.ts packages/core/src/index.ts packages/core/schmock.d.ts
git commit -m "feat(core): add response helpers module

Extract framework-agnostic response helpers (notFound, badRequest,
unauthorized, forbidden, serverError, created, noContent, paginate)
into core for use by all adapters."
```

---

### Task 2: isRouteNotFound Utility

**Files:**
- Modify: `packages/core/src/constants.ts`
- Modify: `packages/core/src/constants.test.ts` (create if doesn't exist)
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing test for isRouteNotFound**

Add to `packages/core/src/constants.test.ts` (create file if it doesn't exist):

```typescript
import { describe, expect, it } from "vitest";
import { ROUTE_NOT_FOUND_CODE, isRouteNotFound } from "./constants.js";

describe("isRouteNotFound", () => {
  it("returns true for a route-not-found response", () => {
    const response = {
      status: 404,
      body: { error: "Route not found", code: ROUTE_NOT_FOUND_CODE },
      headers: {},
    };
    expect(isRouteNotFound(response)).toBe(true);
  });

  it("returns false for a regular 404 response", () => {
    const response = {
      status: 404,
      body: { message: "User not found" },
      headers: {},
    };
    expect(isRouteNotFound(response)).toBe(false);
  });

  it("returns false for a non-404 response", () => {
    const response = {
      status: 200,
      body: { code: ROUTE_NOT_FOUND_CODE },
      headers: {},
    };
    expect(isRouteNotFound(response)).toBe(false);
  });

  it("returns false when body is null", () => {
    const response = { status: 404, body: null, headers: {} };
    expect(isRouteNotFound(response)).toBe(false);
  });

  it("returns false when body is a string", () => {
    const response = { status: 404, body: "not found", headers: {} };
    expect(isRouteNotFound(response)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun vitest run src/constants.test.ts`
Expected: FAIL — `isRouteNotFound` is not exported.

- [ ] **Step 3: Implement isRouteNotFound**

Add to `packages/core/src/constants.ts` at the end of the file (after line 50):

```typescript
/**
 * Check if a Schmock response is a route-not-found response.
 * Used by adapters to decide whether to pass through to the real backend.
 */
export function isRouteNotFound(response: { status: number; body: unknown }): boolean {
  const { status, body } = response;
  return (
    status === 404 &&
    body !== null &&
    typeof body === "object" &&
    "code" in body &&
    body.code === ROUTE_NOT_FOUND_CODE
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun vitest run src/constants.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Export isRouteNotFound from core index**

In `packages/core/src/index.ts`, add `isRouteNotFound` to the constants export block (line 82-89):

```typescript
export {
  HTTP_METHODS,
  isHttpMethod,
  isRouteNotFound,
  isStatusTuple,
  ROUTE_NOT_FOUND_CODE,
  toHttpMethod,
  toRouteKey,
} from "./constants.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/constants.ts packages/core/src/constants.test.ts packages/core/src/index.ts
git commit -m "feat(core): add isRouteNotFound utility

Shared detection for ROUTE_NOT_FOUND responses, replacing duplicated
logic in Express and Angular adapters."
```

---

### Task 3: Fetch Interceptor + mock.intercept()

**Files:**
- Create: `packages/core/src/interceptor.ts`
- Create: `packages/core/src/interceptor.test.ts`
- Create: `packages/core/src/steps/interceptor.steps.ts`
- Create: `features/fetch-interceptor.feature`
- Modify: `packages/core/schmock.d.ts`
- Modify: `packages/core/src/builder.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add intercept types to schmock.d.ts**

Add after the `PaginatedResponse` interface added in Task 1, within the `Schmock` namespace:

```typescript
  // ===== Adapter Types =====

  interface AdapterRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: unknown;
    query: Record<string, string>;
  }

  interface AdapterResponse {
    status: number;
    body: unknown;
    headers: Record<string, string>;
  }

  interface InterceptOptions {
    /** Only intercept URLs whose pathname starts with this prefix */
    baseUrl?: string;
    /** Pass unmatched routes to real fetch (default: true) */
    passthrough?: boolean;
    /** Modify request before Schmock handles it */
    beforeRequest?: (
      request: AdapterRequest,
    ) => AdapterRequest | void | Promise<AdapterRequest | void>;
    /** Modify response before returning to caller */
    beforeResponse?: (
      response: AdapterResponse,
      request: AdapterRequest,
    ) => AdapterResponse | void | Promise<AdapterResponse | void>;
    /** Format errors into custom response bodies */
    errorFormatter?: (error: Error) => unknown;
  }

  interface InterceptHandle {
    /** Stop intercepting and restore original fetch */
    restore(): void;
    /** Whether this interceptor is currently active */
    readonly active: boolean;
  }
```

Add `intercept` method to `CallableMockInstance` interface (after `close(): void;`, around line 372):

```typescript
    // ===== Fetch Interceptor =====

    /**
     * Intercept globalThis.fetch and route requests through this mock.
     * Client-side equivalent of listen().
     *
     * @param options - Intercept configuration
     * @returns Handle with restore() to stop intercepting
     * @throws If already intercepting (call restore() first)
     */
    intercept(options?: InterceptOptions): InterceptHandle;
```

- [ ] **Step 2: Write the BDD feature file**

Create `features/fetch-interceptor.feature`:

```gherkin
Feature: Fetch Interceptor
  As a developer using Schmock in a browser or Node.js environment
  I want to intercept fetch calls and route them through Schmock
  So that I can mock API responses without a running server

  Scenario: Intercept a matched fetch request
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted
    When I fetch "/api/users"
    Then the fetch response status should be 200
    And the fetch response body should be the mocked users

  Scenario: Passthrough for unmatched routes
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted with passthrough enabled
    When I fetch "/api/other"
    Then the original fetch should have been called

  Scenario: Passthrough disabled returns 404
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted with passthrough disabled
    When I fetch "/api/other"
    Then the fetch response status should be 404

  Scenario: Restore puts original fetch back
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted
    When I restore the interceptor
    Then globalThis.fetch should be the original function

  Scenario: BaseUrl filters which requests are intercepted
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted with baseUrl "/api"
    When I fetch "/other/endpoint"
    Then the original fetch should have been called

  Scenario: beforeRequest hook modifies the request
    Given a Schmock instance with route "GET /api/users" that reads headers
    And fetch is intercepted with a beforeRequest hook that adds a header
    When I fetch "/api/users"
    Then the response should contain the injected header value

  Scenario: beforeResponse hook modifies the response
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted with a beforeResponse hook that adds a header
    When I fetch "/api/users"
    Then the fetch response should have the injected header

  Scenario: Double intercept throws an error
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted
    When I try to intercept again
    Then it should throw an error about already intercepting
```

- [ ] **Step 3: Write failing unit tests for the interceptor module**

Create `packages/core/src/interceptor.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schmock } from "./index.js";

describe("mock.intercept()", () => {
  let originalFetch: typeof globalThis.fetch;
  let mock: Schmock.CallableMockInstance;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real backend"));
    mock = schmock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("intercepts a matched fetch request and returns mocked response", async () => {
    mock("GET /api/users", [{ id: 1, name: "Alice" }]);
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/users");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 1, name: "Alice" }]);

    handle.restore();
  });

  it("passes through unmatched routes when passthrough is true", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const handle = mock.intercept({ passthrough: true });

    await fetch("http://localhost/api/other");
    expect(vi.mocked(originalFetch)).not.toHaveBeenCalled();
    // The saved original (our vi.fn mock) should have been called
    // via the interceptor's passthrough path
    handle.restore();
  });

  it("returns 404 when passthrough is disabled and route not found", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const handle = mock.intercept({ passthrough: false });

    const res = await fetch("http://localhost/api/other");
    expect(res.status).toBe(404);

    handle.restore();
  });

  it("restores original fetch", () => {
    const savedFetch = globalThis.fetch;
    const handle = mock.intercept();

    expect(globalThis.fetch).not.toBe(savedFetch);
    handle.restore();
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("reports active status", () => {
    const handle = mock.intercept();
    expect(handle.active).toBe(true);

    handle.restore();
    expect(handle.active).toBe(false);
  });

  it("filters by baseUrl", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const savedFetch = globalThis.fetch;
    const handle = mock.intercept({ baseUrl: "/api" });

    await fetch("http://localhost/other/path");
    // Should have called the saved fetch (passthrough for non-matching baseUrl)
    expect(savedFetch).toHaveBeenCalled();

    handle.restore();
  });

  it("throws when intercepting twice", () => {
    const handle = mock.intercept();
    expect(() => mock.intercept()).toThrow(/already intercepting/i);
    handle.restore();
  });

  it("applies beforeRequest hook", async () => {
    mock("GET /api/users", ({ headers }) => [200, { token: headers["x-token"] }]);
    const handle = mock.intercept({
      beforeRequest: (req) => ({
        ...req,
        headers: { ...req.headers, "x-token": "injected" },
      }),
    });

    const res = await fetch("http://localhost/api/users");
    expect(await res.json()).toEqual({ token: "injected" });

    handle.restore();
  });

  it("applies beforeResponse hook", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const handle = mock.intercept({
      beforeResponse: (res) => ({
        ...res,
        headers: { ...res.headers, "x-mock": "true" },
      }),
    });

    const res = await fetch("http://localhost/api/users");
    expect(res.headers.get("x-mock")).toBe("true");

    handle.restore();
  });

  it("handles relative URLs", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const handle = mock.intercept();

    const res = await fetch("/api/users");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 1 }]);

    handle.restore();
  });

  it("applies errorFormatter", async () => {
    mock("GET /api/fail", () => {
      throw new Error("boom");
    });
    const handle = mock.intercept({
      errorFormatter: (err) => ({ custom: err.message }),
    });

    const res = await fetch("http://localhost/api/fail");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ custom: "boom" });

    handle.restore();
  });

  it("parses JSON body from fetch init", async () => {
    mock("POST /api/users", ({ body }) => [201, body]);
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: "Alice" });

    handle.restore();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd packages/core && bun vitest run src/interceptor.test.ts`
Expected: FAIL — `mock.intercept` is not a function.

- [ ] **Step 5: Implement the interceptor module**

Create `packages/core/src/interceptor.ts`:

```typescript
/// <reference path="../schmock.d.ts" />

import { isRouteNotFound } from "./constants.js";
import { SchmockError } from "./errors.js";
import { toHttpMethod } from "./constants.js";

/**
 * Extract pathname from a URL string, handling both absolute and relative URLs.
 */
function extractPathname(url: string): string {
  const queryStart = url.indexOf("?");
  const urlWithoutQuery = queryStart === -1 ? url : url.slice(0, queryStart);

  if (urlWithoutQuery.includes("://")) {
    try {
      return new URL(urlWithoutQuery).pathname;
    } catch {
      // Fall through to simple extraction
    }
  }

  if (!urlWithoutQuery.startsWith("/")) {
    return `/${urlWithoutQuery}`;
  }

  return urlWithoutQuery;
}

/**
 * Extract query parameters from a URL string.
 */
function extractQuery(url: string): Record<string, string> {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return {};

  const params = new URLSearchParams(url.slice(queryStart + 1));
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/**
 * Extract headers from fetch init or Request object.
 */
function extractHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
): Record<string, string> {
  const headers: Record<string, string> = {};

  const raw = input instanceof Request ? input.headers : init?.headers;
  if (!raw) return headers;

  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(raw)) {
    for (const [key, value] of raw) {
      headers[key] = value;
    }
  } else {
    Object.assign(headers, raw);
  }

  return headers;
}

/**
 * Extract body from fetch init, parsing JSON when possible.
 */
async function extractBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<unknown> {
  const rawBody = input instanceof Request ? input.body : init?.body;
  if (rawBody === null || rawBody === undefined) return undefined;

  // String body — try to parse as JSON
  const bodyInit = init?.body;
  if (typeof bodyInit === "string") {
    try {
      return JSON.parse(bodyInit);
    } catch {
      return bodyInit;
    }
  }

  // Request with body — clone and read
  if (input instanceof Request && input.body) {
    try {
      return await input.clone().json();
    } catch {
      try {
        return await input.clone().text();
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

/**
 * Create a fetch interceptor that routes requests through mock.handle().
 */
export function createFetchInterceptor(
  handle: (
    method: Schmock.HttpMethod,
    path: string,
    options?: Schmock.RequestOptions,
  ) => Promise<Schmock.Response>,
  options: Schmock.InterceptOptions = {},
): Schmock.InterceptHandle {
  const {
    baseUrl,
    passthrough = true,
    beforeRequest,
    beforeResponse,
    errorFormatter,
  } = options;

  const originalFetch = globalThis.fetch;
  let active = true;

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // Resolve the URL string
    const urlString =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;

    const path = extractPathname(urlString);

    // BaseUrl filter — non-matching requests go straight to real fetch
    if (baseUrl && !path.startsWith(baseUrl)) {
      return originalFetch(input, init);
    }

    // Build adapter request
    const method =
      input instanceof Request ? input.method : init?.method ?? "GET";
    const headers = extractHeaders(input, init);
    const query = extractQuery(urlString);
    const body = await extractBody(input, init);

    let adapterRequest: Schmock.AdapterRequest = {
      method,
      path,
      headers,
      body,
      query,
    };

    // Apply beforeRequest hook
    if (beforeRequest) {
      const modified = await beforeRequest(adapterRequest);
      if (modified) {
        adapterRequest = modified;
      }
    }

    try {
      const schmockResponse = await handle(
        toHttpMethod(adapterRequest.method),
        adapterRequest.path,
        {
          headers: adapterRequest.headers,
          body: adapterRequest.body,
          query: adapterRequest.query,
        },
      );

      // Route not found — passthrough or 404
      if (isRouteNotFound(schmockResponse)) {
        if (passthrough) {
          return originalFetch(input, init);
        }
        return new Response(
          JSON.stringify({
            error: "No matching mock route found",
            code: "ROUTE_NOT_FOUND",
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Apply beforeResponse hook
      let response: Schmock.AdapterResponse = schmockResponse;
      if (beforeResponse) {
        const modified = await beforeResponse(response, adapterRequest);
        if (modified) {
          response = modified;
        }
      }

      // Build fetch Response
      const responseHeaders = new Headers(response.headers);
      if (
        !responseHeaders.has("content-type") &&
        response.body !== null &&
        response.body !== undefined
      ) {
        responseHeaders.set("content-type", "application/json");
      }

      const responseBody =
        response.body === null || response.body === undefined
          ? null
          : typeof response.body === "string"
            ? response.body
            : JSON.stringify(response.body);

      return new Response(responseBody, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (error) {
      if (errorFormatter) {
        const formatted = errorFormatter(
          error instanceof Error ? error : new Error(String(error)),
        );
        return new Response(JSON.stringify(formatted), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      throw error;
    }
  };

  return {
    restore() {
      if (active) {
        globalThis.fetch = originalFetch;
        active = false;
      }
    },
    get active() {
      return active;
    },
  };
}
```

- [ ] **Step 6: Wire intercept() into the builder**

In `packages/core/src/builder.ts`, add an import at the top:

```typescript
import { createFetchInterceptor } from "./interceptor.js";
```

Add a private field to `CallableMockInstance` class (near other private fields):

```typescript
private interceptHandle: Schmock.InterceptHandle | null = null;
```

Add the `intercept` method after `close()` (after the Standalone Server section):

```typescript
  // ===== Fetch Interceptor =====

  intercept(options?: Schmock.InterceptOptions): Schmock.InterceptHandle {
    if (this.interceptHandle?.active) {
      throw new SchmockError(
        "Already intercepting. Call restore() first.",
        "ALREADY_INTERCEPTING",
      );
    }

    this.interceptHandle = createFetchInterceptor(
      (method, path, opts) => this.handle(method, path, opts),
      options,
    );

    return this.interceptHandle;
  }
```

- [ ] **Step 7: Wire intercept on the callable instance proxy**

In `packages/core/src/index.ts`, add `intercept` to the `Object.assign` block (after `close`, around line 72):

```typescript
      close: instance.close.bind(instance),
      intercept: (options?: Schmock.InterceptOptions) => instance.intercept(options),
```

- [ ] **Step 8: Run unit tests to verify they pass**

Run: `cd packages/core && bun vitest run src/interceptor.test.ts`
Expected: All tests PASS.

- [ ] **Step 9: Write BDD step definitions**

Create `packages/core/src/steps/interceptor.steps.ts`:

```typescript
/// <reference path="../../schmock.d.ts" />

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, vi, afterEach } from "vitest";
import { schmock } from "../index.js";

const feature = loadFeature("features/fetch-interceptor.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let handle: Schmock.InterceptHandle | undefined;
  let originalFetch: typeof globalThis.fetch;
  let fetchResponse: Response | undefined;

  const savedFetch = vi.fn().mockResolvedValue(new Response("real backend"));

  afterEach(() => {
    handle?.restore();
    globalThis.fetch = originalFetch;
  });

  function setup() {
    originalFetch = globalThis.fetch;
    globalThis.fetch = savedFetch;
    savedFetch.mockClear();
    mock = schmock();
    fetchResponse = undefined;
  }

  Scenario("Intercept a matched fetch request", ({ Given, When, Then, And }) => {
    setup();

    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock("GET /api/users", [{ id: 1, name: "Alice" }]);
    });

    And("fetch is intercepted", () => {
      handle = mock.intercept();
    });

    When("I fetch \"/api/users\"", async () => {
      fetchResponse = await fetch("http://localhost/api/users");
    });

    Then("the fetch response status should be 200", () => {
      expect(fetchResponse?.status).toBe(200);
    });

    And("the fetch response body should be the mocked users", async () => {
      const body = await fetchResponse?.json();
      expect(body).toEqual([{ id: 1, name: "Alice" }]);
    });
  });

  Scenario("Passthrough for unmatched routes", ({ Given, When, Then, And }) => {
    setup();

    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted with passthrough enabled", () => {
      handle = mock.intercept({ passthrough: true });
    });

    When("I fetch \"/api/other\"", async () => {
      fetchResponse = await fetch("http://localhost/api/other");
    });

    Then("the original fetch should have been called", () => {
      expect(savedFetch).toHaveBeenCalled();
    });
  });

  Scenario("Passthrough disabled returns 404", ({ Given, When, Then, And }) => {
    setup();

    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted with passthrough disabled", () => {
      handle = mock.intercept({ passthrough: false });
    });

    When("I fetch \"/api/other\"", async () => {
      fetchResponse = await fetch("http://localhost/api/other");
    });

    Then("the fetch response status should be 404", () => {
      expect(fetchResponse?.status).toBe(404);
    });
  });

  Scenario("Restore puts original fetch back", ({ Given, When, Then, And }) => {
    setup();
    let savedRef: typeof globalThis.fetch;

    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted", () => {
      savedRef = globalThis.fetch;
      handle = mock.intercept();
    });

    When("I restore the interceptor", () => {
      handle?.restore();
    });

    Then("globalThis.fetch should be the original function", () => {
      expect(globalThis.fetch).toBe(savedRef);
    });
  });

  Scenario("BaseUrl filters which requests are intercepted", ({ Given, When, Then, And }) => {
    setup();

    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted with baseUrl \"/api\"", () => {
      handle = mock.intercept({ baseUrl: "/api" });
    });

    When("I fetch \"/other/endpoint\"", async () => {
      await fetch("http://localhost/other/endpoint");
    });

    Then("the original fetch should have been called", () => {
      expect(savedFetch).toHaveBeenCalled();
    });
  });

  Scenario("beforeRequest hook modifies the request", ({ Given, When, Then, And }) => {
    setup();

    Given("a Schmock instance with route \"GET /api/users\" that reads headers", () => {
      mock("GET /api/users", ({ headers }) => [200, { token: headers["x-token"] }]);
    });

    And("fetch is intercepted with a beforeRequest hook that adds a header", () => {
      handle = mock.intercept({
        beforeRequest: (req) => ({
          ...req,
          headers: { ...req.headers, "x-token": "injected" },
        }),
      });
    });

    When("I fetch \"/api/users\"", async () => {
      fetchResponse = await fetch("http://localhost/api/users");
    });

    Then("the response should contain the injected header value", async () => {
      const body = await fetchResponse?.json();
      expect(body).toEqual({ token: "injected" });
    });
  });

  Scenario("beforeResponse hook modifies the response", ({ Given, When, Then, And }) => {
    setup();

    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted with a beforeResponse hook that adds a header", () => {
      handle = mock.intercept({
        beforeResponse: (res) => ({
          ...res,
          headers: { ...res.headers, "x-mock": "true" },
        }),
      });
    });

    When("I fetch \"/api/users\"", async () => {
      fetchResponse = await fetch("http://localhost/api/users");
    });

    Then("the fetch response should have the injected header", () => {
      expect(fetchResponse?.headers.get("x-mock")).toBe("true");
    });
  });

  Scenario("Double intercept throws an error", ({ Given, When, Then, And }) => {
    setup();
    let error: Error | undefined;

    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted", () => {
      handle = mock.intercept();
    });

    When("I try to intercept again", () => {
      try {
        mock.intercept();
      } catch (e) {
        error = e as Error;
      }
    });

    Then("it should throw an error about already intercepting", () => {
      expect(error?.message).toMatch(/already intercepting/i);
    });
  });
});
```

- [ ] **Step 10: Run all core tests**

Run: `cd packages/core && bun vitest run`
Then: `cd packages/core && bun test:bdd`
Expected: All unit and BDD tests PASS.

- [ ] **Step 11: Verify build**

Run: `cd packages/core && bun run build`
Expected: Build succeeds without errors.

- [ ] **Step 12: Commit**

```bash
git add packages/core/src/interceptor.ts packages/core/src/interceptor.test.ts packages/core/src/steps/interceptor.steps.ts features/fetch-interceptor.feature packages/core/schmock.d.ts packages/core/src/builder.ts packages/core/src/index.ts
git commit -m "feat(core): add mock.intercept() for client-side fetch interception

Patches globalThis.fetch to route requests through mock.handle().
Supports baseUrl filtering, passthrough, request/response hooks,
and error formatting. Client-side equivalent of mock.listen()."
```

---

## Phase 2: Adapter Refactor

### Task 4: Refactor Express Adapter

**Files:**
- Modify: `packages/express/src/index.ts`

- [ ] **Step 1: Run existing Express BDD tests to confirm green baseline**

Run: `cd packages/express && bun test:bdd`
Expected: All 6 scenarios PASS.

- [ ] **Step 2: Replace inline ROUTE_NOT_FOUND detection with core utility**

In `packages/express/src/index.ts`, update the import (line 3-7):

```typescript
import {
  ROUTE_NOT_FOUND_CODE,
  SchmockError,
  isRouteNotFound,
  toHttpMethod,
} from "@schmock/core";
```

Replace lines 206-217 (the inline detection block):

```typescript
      // Detect ROUTE_NOT_FOUND responses and pass to next middleware
      const body = schmockResponse.body;
      if (
        schmockResponse.status === 404 &&
        body &&
        typeof body === "object" &&
        "code" in body &&
        body.code === ROUTE_NOT_FOUND_CODE
      ) {
        next();
        return;
      }
```

With:

```typescript
      // Detect ROUTE_NOT_FOUND responses and pass to next middleware
      if (isRouteNotFound(schmockResponse)) {
        next();
        return;
      }
```

Remove `ROUTE_NOT_FOUND_CODE` from the import if no longer used elsewhere in the file.

- [ ] **Step 3: Run Express BDD tests to confirm still green**

Run: `cd packages/express && bun test:bdd`
Expected: All 6 scenarios PASS (no behavior change).

- [ ] **Step 4: Commit**

```bash
git add packages/express/src/index.ts
git commit -m "refactor(express): use isRouteNotFound from core

Replace inline ROUTE_NOT_FOUND detection with shared utility."
```

---

### Task 5: Refactor Angular Adapter

**Files:**
- Modify: `packages/angular/src/index.ts`

- [ ] **Step 1: Run existing Angular BDD tests to confirm green baseline**

Run: `cd packages/angular && bun test:bdd`
Expected: All scenarios PASS.

- [ ] **Step 2: Replace inline ROUTE_NOT_FOUND detection with core utility**

In `packages/angular/src/index.ts`, add `isRouteNotFound` to the import from `@schmock/core` (line 16):

```typescript
import { isHttpMethod, isRouteNotFound, ROUTE_NOT_FOUND_CODE } from "@schmock/core";
```

Replace lines 250-257 (the inline detection block):

```typescript
            const body = schmockResponse.body;
            const isRouteNotFound =
              schmockResponse.status === 404 &&
              body !== null &&
              typeof body === "object" &&
              "code" in body &&
              body.code === ROUTE_NOT_FOUND_CODE;
```

With:

```typescript
            const routeNotFound = isRouteNotFound(schmockResponse);
```

And update the references from `isRouteNotFound` to `routeNotFound` on lines 259 and 262 (or wherever the variable is used in the `if` blocks).

Remove `ROUTE_NOT_FOUND_CODE` from the import if no longer used elsewhere.

- [ ] **Step 3: Replace response helpers with re-exports from core**

Delete the response helper implementations from `packages/angular/src/index.ts` (lines 453-576 approximately — the `notFound`, `badRequest`, `unauthorized`, `forbidden`, `serverError`, `created`, `noContent`, `paginate` functions and `PaginateOptions`/`PaginatedResponse` interfaces).

Replace them with re-exports from core:

```typescript
// Re-export response helpers from core for backwards compatibility
export {
  badRequest,
  created,
  forbidden,
  noContent,
  notFound,
  paginate,
  serverError,
  unauthorized,
} from "@schmock/core";
export type { PaginateOptions, PaginatedResponse } from "@schmock/core";
```

- [ ] **Step 4: Run Angular BDD tests to confirm still green**

Run: `cd packages/angular && bun test:bdd`
Expected: All scenarios PASS (no behavior change — helpers are the same implementation).

- [ ] **Step 5: Commit**

```bash
git add packages/angular/src/index.ts
git commit -m "refactor(angular): use core primitives

Use isRouteNotFound from core, re-export response helpers from core
instead of maintaining local copies."
```

---

### Task 6: Update Meta-Package and Build Order

**Files:**
- Modify: `packages/schmock/package.json`
- Modify: `packages/schmock/src/index.ts`
- Modify: `package.json` (root — build order)

- [ ] **Step 1: Remove framework adapter deps from meta-package**

In `packages/schmock/package.json`, update `dependencies` to remove Express and Angular:

```json
  "dependencies": {
    "@schmock/core": "^1.13.0",
    "@schmock/faker": "^1.13.0",
    "@schmock/validation": "^1.13.0",
    "@schmock/query": "^1.13.0",
    "@schmock/openapi": "^1.13.0",
    "@schmock/cli": "^1.13.0"
  },
```

Update the `description` field:

```json
  "description": "All-in-one Schmock package — installs core, faker, validation, query, openapi, and CLI",
```

Update `keywords` — remove `"express"` and `"angular"`.

Update `build:lib` script to remove `--external @schmock/express --external @schmock/angular`.

- [ ] **Step 2: Update meta-package index to export helpers**

In `packages/schmock/src/index.ts`, add response helper re-exports:

```typescript
/**
 * @schmock/schmock — Meta-package that installs all Schmock packages.
 *
 * Usage:
 *   bun install @schmock/schmock
 *
 * This gives you access to all @schmock/* packages:
 *   - @schmock/core — Core mock builder + fetch interceptor
 *   - @schmock/faker — Faker-powered data generation
 *   - @schmock/validation — Request/response validation
 *   - @schmock/query — Pagination, sorting, filtering
 *   - @schmock/openapi — Auto-register routes from OpenAPI specs
 *   - @schmock/cli — Standalone CLI server
 *
 * Framework adapters (install separately):
 *   - @schmock/react — React Provider + hooks
 *   - @schmock/vue — Vue Plugin + composables
 *   - @schmock/express — Express middleware
 *   - @schmock/angular — Angular HTTP interceptor
 *
 * Import from individual packages:
 *   import { schmock } from "@schmock/core";
 *   import { openapi } from "@schmock/openapi";
 */
export { schmock } from "@schmock/core";
export {
  badRequest,
  created,
  forbidden,
  noContent,
  notFound,
  paginate,
  serverError,
  unauthorized,
} from "@schmock/core";
```

- [ ] **Step 3: Run full test suite**

Run: `bun test:quiet` (from root)
Expected: All tests across all packages PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/schmock/package.json packages/schmock/src/index.ts
git commit -m "refactor(schmock): remove framework adapters from meta-package

Meta-package now includes core + plugins + CLI only. Framework
adapters (express, angular, react, vue) are installed separately."
```

---

## Phase 3: New Adapters

### Task 7: @schmock/react Adapter

**Files:**
- Create: `packages/react/package.json`
- Create: `packages/react/tsconfig.json`
- Create: `packages/react/vitest.config.ts`
- Create: `packages/react/vitest.config.bdd.ts`
- Create: `packages/react/src/index.ts`
- Create: `packages/react/src/index.test.ts`
- Create: `packages/react/src/steps/react-adapter.steps.ts`
- Create: `features/react-adapter.feature`
- Modify: `package.json` (root — add to build order + workspaces)

- [ ] **Step 1: Write the BDD feature file**

Create `features/react-adapter.feature`:

```gherkin
Feature: React Adapter
  As a React developer
  I want to use Schmock with React components
  So that I can mock API responses in my React applications

  Scenario: SchmockProvider intercepts fetch calls
    Given a Schmock instance with route "GET /api/users" returning users
    When I render a component that fetches "/api/users" inside SchmockProvider
    Then the component should display the mocked users

  Scenario: SchmockProvider restores fetch on unmount
    Given a Schmock instance with route "GET /api/users" returning users
    When I mount and unmount a SchmockProvider
    Then fetch should be restored to the original implementation

  Scenario: useSchmock returns the mock instance
    Given a Schmock instance
    When I render a component that calls useSchmock inside SchmockProvider
    Then it should receive the CallableMockInstance

  Scenario: Passthrough for unmatched routes
    Given a Schmock instance with route "GET /api/users" returning users
    And the provider is configured with passthrough enabled
    When the component fetches "/api/other"
    Then the request should pass through to the original fetch

  Scenario: renderWithSchmock test utility handles setup and cleanup
    Given route definitions for "GET /api/users" returning users
    When I use renderWithSchmock to render a component that fetches "/api/users"
    Then the component should display the mocked users
```

- [ ] **Step 2: Scaffold the package**

Create `packages/react/package.json`:

```json
{
  "name": "@schmock/react",
  "version": "1.13.0",
  "description": "React adapter for Schmock — Provider, hooks, and test utilities",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./testing": {
      "types": "./dist/testing.d.ts",
      "import": "./dist/testing.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "bun build:lib && bun build:types",
    "build:lib": "bun build --minify --target browser --outdir=dist src/index.ts src/testing.ts --external @schmock/core --external react --external @testing-library/react",
    "build:types": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest --watch",
    "test:bdd": "vitest run --config vitest.config.bdd.ts",
    "lint": "biome check src/",
    "lint:fix": "biome check --write --unsafe src/",
    "check:publish": "publint && attw --pack --ignore-rules cjs-resolves-to-esm"
  },
  "license": "MIT",
  "dependencies": {
    "@schmock/core": "^1.13.0"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0",
    "@testing-library/react": "^16.0.0"
  },
  "peerDependenciesMeta": {
    "@testing-library/react": {
      "optional": true
    }
  },
  "devDependencies": {
    "@amiceli/vitest-cucumber": "^6.3.0",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^19.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "jsdom": "^26.0.0",
    "vitest": "^4.1.1"
  },
  "keywords": [
    "schmock",
    "mock",
    "react",
    "testing",
    "api"
  ],
  "author": "Khalic Lab"
}
```

Create `packages/react/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "composite": true,
    "emitDeclarationOnly": false,
    "jsx": "react-jsx"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "**/*.test.tsx", "**/*.steps.ts"]
}
```

Create `packages/react/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/*.steps.ts"],
  },
});
```

Create `packages/react/vitest.config.bdd.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.steps.ts"],
    testTimeout: 30_000,
    reporters: [["default", { summary: false }]],
  },
});
```

- [ ] **Step 3: Write failing unit tests**

Create `packages/react/src/index.test.tsx`:

```typescript
/// <reference path="../../core/schmock.d.ts" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import React, { useEffect, useState } from "react";
import { schmock } from "@schmock/core";
import { SchmockProvider, useSchmock } from "./index.js";
import { renderWithSchmock } from "./testing.js";

function UserList() {
  const [users, setUsers] = useState<Array<{ id: number; name: string }>>([]);

  useEffect(() => {
    fetch("http://localhost/api/users")
      .then((res) => res.json())
      .then(setUsers);
  }, []);

  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}

function MockConsumer() {
  const mock = useSchmock();
  return <div data-testid="has-mock">{mock ? "yes" : "no"}</div>;
}

describe("SchmockProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("intercepts fetch and provides mocked data", async () => {
    const mock = schmock();
    mock("GET /api/users", [{ id: 1, name: "Alice" }]);

    render(
      <SchmockProvider mock={mock}>
        <UserList />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeDefined();
    });
  });

  it("restores fetch on unmount", () => {
    const mock = schmock();
    const savedFetch = globalThis.fetch;

    const { unmount } = render(
      <SchmockProvider mock={mock}>
        <div />
      </SchmockProvider>,
    );

    expect(globalThis.fetch).not.toBe(savedFetch);
    unmount();
    expect(globalThis.fetch).toBe(savedFetch);
  });
});

describe("useSchmock", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("returns the mock instance from context", async () => {
    const mock = schmock();

    render(
      <SchmockProvider mock={mock}>
        <MockConsumer />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("has-mock").textContent).toBe("yes");
    });
  });

  it("throws when used outside SchmockProvider", () => {
    expect(() => render(<MockConsumer />)).toThrow(/SchmockProvider/);
  });
});

describe("renderWithSchmock", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("sets up provider with routes and cleans up", async () => {
    const { unmount } = renderWithSchmock(<UserList />, {
      routes: [["GET /api/users", [{ id: 1, name: "Bob" }]]],
    });

    await waitFor(() => {
      expect(screen.getByText("Bob")).toBeDefined();
    });

    const fetchBeforeUnmount = globalThis.fetch;
    unmount();
    expect(globalThis.fetch).not.toBe(fetchBeforeUnmount);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd packages/react && bun vitest run`
Expected: FAIL — `./index.js` has no exports.

- [ ] **Step 5: Implement the React adapter**

Create `packages/react/src/index.ts`:

```typescript
/// <reference path="../../core/schmock.d.ts" />

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

// ===== Context =====

export const SchmockContext = createContext<Schmock.CallableMockInstance | null>(null);

// ===== Provider =====

export interface SchmockProviderProps {
  mock: Schmock.CallableMockInstance;
  options?: Schmock.InterceptOptions;
  children: ReactNode;
}

export function SchmockProvider({ mock, options, children }: SchmockProviderProps) {
  const handleRef = useRef<Schmock.InterceptHandle | null>(null);

  useEffect(() => {
    handleRef.current = mock.intercept(options);

    return () => {
      handleRef.current?.restore();
      handleRef.current = null;
    };
  }, [mock, options]);

  return createElement(SchmockContext.Provider, { value: mock }, children);
}

// ===== Hook =====

export function useSchmock(): Schmock.CallableMockInstance {
  const mock = useContext(SchmockContext);
  if (mock === null) {
    throw new Error("useSchmock must be used within a SchmockProvider");
  }
  return mock;
}
```

Create `packages/react/src/testing.ts`:

```typescript
/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { SchmockProvider } from "./index.js";

export interface RenderWithSchmockOptions {
  routes?: Array<[Schmock.RouteKey, Schmock.Generator, Schmock.RouteConfig?]>;
  interceptOptions?: Schmock.InterceptOptions;
  mock?: Schmock.CallableMockInstance;
}

export function renderWithSchmock(
  ui: ReactNode,
  options: RenderWithSchmockOptions = {},
) {
  const mock = options.mock ?? schmock();

  if (options.routes) {
    for (const [route, generator, config] of options.routes) {
      mock(route, generator, config);
    }
  }

  const result = render(
    createElement(SchmockProvider, {
      mock,
      options: options.interceptOptions,
      children: ui,
    }),
  );

  return {
    ...result,
    mock,
  };
}
```

- [ ] **Step 6: Run unit tests to verify they pass**

Run: `cd packages/react && bun vitest run`
Expected: All tests PASS.

- [ ] **Step 7: Write BDD step definitions**

Create `packages/react/src/steps/react-adapter.steps.ts`:

```typescript
/// <reference path="../../../core/schmock.d.ts" />

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import React, { useEffect, useState } from "react";
import { schmock } from "@schmock/core";
import { SchmockProvider, useSchmock } from "../index.js";
import { renderWithSchmock } from "../testing.js";

const feature = loadFeature("features/react-adapter.feature");

function UserList() {
  const [users, setUsers] = useState<Array<{ id: number; name: string }>>([]);

  useEffect(() => {
    fetch("http://localhost/api/users")
      .then((res) => res.json())
      .then(setUsers);
  }, []);

  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}

function MockConsumer() {
  const mock = useSchmock();
  return <div data-testid="has-mock">{mock ? "yes" : "no"}</div>;
}

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let originalFetch: typeof globalThis.fetch;
  const fakeFetch = vi.fn().mockResolvedValue(new Response("real"));

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    fakeFetch.mockClear();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  Scenario("SchmockProvider intercepts fetch calls", ({ Given, When, Then }) => {
    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock = schmock();
      mock("GET /api/users", [{ id: 1, name: "Alice" }]);
    });

    When("I render a component that fetches \"/api/users\" inside SchmockProvider", () => {
      render(
        <SchmockProvider mock={mock}>
          <UserList />
        </SchmockProvider>,
      );
    });

    Then("the component should display the mocked users", async () => {
      await waitFor(() => {
        expect(screen.getByText("Alice")).toBeDefined();
      });
    });
  });

  Scenario("SchmockProvider restores fetch on unmount", ({ Given, When, Then }) => {
    let savedFetch: typeof globalThis.fetch;

    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock = schmock();
      mock("GET /api/users", [{ id: 1 }]);
    });

    When("I mount and unmount a SchmockProvider", () => {
      savedFetch = globalThis.fetch;
      const { unmount } = render(
        <SchmockProvider mock={mock}>
          <div />
        </SchmockProvider>,
      );
      unmount();
    });

    Then("fetch should be restored to the original implementation", () => {
      expect(globalThis.fetch).toBe(savedFetch);
    });
  });

  Scenario("useSchmock returns the mock instance", ({ Given, When, Then }) => {
    Given("a Schmock instance", () => {
      mock = schmock();
    });

    When("I render a component that calls useSchmock inside SchmockProvider", () => {
      render(
        <SchmockProvider mock={mock}>
          <MockConsumer />
        </SchmockProvider>,
      );
    });

    Then("it should receive the CallableMockInstance", async () => {
      await waitFor(() => {
        expect(screen.getByTestId("has-mock").textContent).toBe("yes");
      });
    });
  });

  Scenario("Passthrough for unmatched routes", ({ Given, When, Then, And }) => {
    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock = schmock();
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("the provider is configured with passthrough enabled", () => {
      render(
        <SchmockProvider mock={mock} options={{ passthrough: true }}>
          <div />
        </SchmockProvider>,
      );
    });

    When("the component fetches \"/api/other\"", async () => {
      await fetch("http://localhost/api/other");
    });

    Then("the request should pass through to the original fetch", () => {
      expect(fakeFetch).toHaveBeenCalled();
    });
  });

  Scenario("renderWithSchmock test utility handles setup and cleanup", ({ Given, When, Then }) => {
    Given("route definitions for \"GET /api/users\" returning users", () => {
      // Routes defined inline in renderWithSchmock
    });

    When("I use renderWithSchmock to render a component that fetches \"/api/users\"", () => {
      renderWithSchmock(<UserList />, {
        routes: [["GET /api/users", [{ id: 1, name: "Bob" }]]],
      });
    });

    Then("the component should display the mocked users", async () => {
      await waitFor(() => {
        expect(screen.getByText("Bob")).toBeDefined();
      });
    });
  });
});
```

- [ ] **Step 8: Run BDD tests**

Run: `cd packages/react && bun test:bdd`
Expected: All 5 scenarios PASS.

- [ ] **Step 9: Add to root build order**

In root `package.json`, add `@schmock/react` to the `build` script (before `@schmock/schmock`):

```
... && bun run --filter @schmock/react build && bun run --filter @schmock/schmock build
```

Add `@schmock/react` to the `test:bdd` filter if needed. Also run `bun install` to register the new workspace.

- [ ] **Step 10: Verify full build and tests**

Run: `bun install && bun run build && bun test:quiet`
Expected: All packages build and all tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/react/ features/react-adapter.feature package.json
git commit -m "feat(react): add React adapter with Provider, hook, and test utility

SchmockProvider wraps mock.intercept() with React lifecycle.
useSchmock hook provides access to the mock instance.
renderWithSchmock (via @schmock/react/testing) simplifies test setup."
```

---

### Task 8: @schmock/vue Adapter

**Files:**
- Create: `packages/vue/package.json`
- Create: `packages/vue/tsconfig.json`
- Create: `packages/vue/vitest.config.ts`
- Create: `packages/vue/vitest.config.bdd.ts`
- Create: `packages/vue/src/index.ts`
- Create: `packages/vue/src/index.test.ts`
- Create: `packages/vue/src/steps/vue-adapter.steps.ts`
- Create: `features/vue-adapter.feature`
- Modify: `package.json` (root — add to build order)

- [ ] **Step 1: Write the BDD feature file**

Create `features/vue-adapter.feature`:

```gherkin
Feature: Vue Adapter
  As a Vue developer
  I want to use Schmock with Vue components
  So that I can mock API responses in my Vue applications

  Scenario: SchmockPlugin intercepts fetch calls
    Given a Schmock instance with route "GET /api/users" returning users
    When I mount a component that fetches "/api/users" with the Schmock plugin
    Then the component should display the mocked users

  Scenario: Plugin restores fetch on app unmount
    Given a Schmock instance with route "GET /api/users" returning users
    When I mount and unmount a Vue app with the Schmock plugin
    Then fetch should be restored to the original implementation

  Scenario: useSchmock returns the mock instance
    Given a Schmock instance
    When I use the useSchmock composable inside a component with the plugin
    Then it should receive the CallableMockInstance

  Scenario: Passthrough for unmatched routes
    Given a Schmock instance with route "GET /api/users" returning users
    And the plugin is configured with passthrough enabled
    When the component fetches "/api/other"
    Then the request should pass through to the original fetch
```

- [ ] **Step 2: Scaffold the package**

Create `packages/vue/package.json`:

```json
{
  "name": "@schmock/vue",
  "version": "1.13.0",
  "description": "Vue adapter for Schmock — Plugin and composables",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "bun build:lib && bun build:types",
    "build:lib": "bun build --minify --target browser --outdir=dist src/index.ts --external @schmock/core --external vue",
    "build:types": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest --watch",
    "test:bdd": "vitest run --config vitest.config.bdd.ts",
    "lint": "biome check src/",
    "lint:fix": "biome check --write --unsafe src/",
    "check:publish": "publint && attw --pack --ignore-rules cjs-resolves-to-esm"
  },
  "license": "MIT",
  "dependencies": {
    "@schmock/core": "^1.13.0"
  },
  "peerDependencies": {
    "vue": "^3.3.0"
  },
  "devDependencies": {
    "@amiceli/vitest-cucumber": "^6.3.0",
    "@vue/test-utils": "^2.4.0",
    "jsdom": "^26.0.0",
    "vue": "^3.5.0",
    "vitest": "^4.1.1"
  },
  "keywords": [
    "schmock",
    "mock",
    "vue",
    "testing",
    "api"
  ],
  "author": "Khalic Lab"
}
```

Create `packages/vue/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "composite": true,
    "emitDeclarationOnly": false
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "**/*.steps.ts"]
}
```

Create `packages/vue/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.steps.ts"],
  },
});
```

Create `packages/vue/vitest.config.bdd.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.steps.ts"],
    testTimeout: 30_000,
    reporters: [["default", { summary: false }]],
  },
});
```

- [ ] **Step 3: Write failing unit tests**

Create `packages/vue/src/index.test.ts`:

```typescript
/// <reference path="../../core/schmock.d.ts" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, onMounted, ref } from "vue";
import { mount } from "@vue/test-utils";
import { schmock } from "@schmock/core";
import { schmockPlugin, useSchmock } from "./index.js";

const UserList = defineComponent({
  setup() {
    const users = ref<Array<{ id: number; name: string }>>([]);

    onMounted(async () => {
      const res = await fetch("http://localhost/api/users");
      users.value = await res.json();
    });

    return () =>
      h(
        "ul",
        users.value.map((u) => h("li", { key: u.id }, u.name)),
      );
  },
});

const MockConsumer = defineComponent({
  setup() {
    const mock = useSchmock();
    return () => h("div", { "data-testid": "has-mock" }, mock ? "yes" : "no");
  },
});

describe("schmockPlugin", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("intercepts fetch when plugin is installed", async () => {
    const mock = schmock();
    mock("GET /api/users", [{ id: 1, name: "Alice" }]);

    const wrapper = mount(UserList, {
      global: {
        plugins: [[schmockPlugin, { mock }]],
      },
    });

    // Wait for fetch + re-render
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("Alice");
    });
  });

  it("restores fetch on app unmount", () => {
    const mock = schmock();
    const savedFetch = globalThis.fetch;

    const wrapper = mount(
      defineComponent({ render: () => h("div") }),
      { global: { plugins: [[schmockPlugin, { mock }]] } },
    );

    expect(globalThis.fetch).not.toBe(savedFetch);
    wrapper.unmount();
    expect(globalThis.fetch).toBe(savedFetch);
  });
});

describe("useSchmock", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns mock instance from injected context", () => {
    const mock = schmock();

    const wrapper = mount(MockConsumer, {
      global: { plugins: [[schmockPlugin, { mock }]] },
    });

    expect(wrapper.find("[data-testid='has-mock']").text()).toBe("yes");
  });

  it("throws when used without the plugin", () => {
    expect(() => mount(MockConsumer)).toThrow(/schmockPlugin/);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd packages/vue && bun vitest run`
Expected: FAIL — `./index.js` has no exports.

- [ ] **Step 5: Implement the Vue adapter**

Create `packages/vue/src/index.ts`:

```typescript
/// <reference path="../../core/schmock.d.ts" />

import {
  inject,
  onUnmounted,
  type App,
  type InjectionKey,
  type Plugin,
} from "vue";

// ===== Injection Key =====

const SCHMOCK_KEY: InjectionKey<Schmock.CallableMockInstance> =
  Symbol("schmock");

// ===== Plugin =====

export interface SchmockPluginOptions {
  mock: Schmock.CallableMockInstance;
  interceptOptions?: Schmock.InterceptOptions;
}

export const schmockPlugin: Plugin<SchmockPluginOptions> = {
  install(app: App, options: SchmockPluginOptions) {
    const { mock, interceptOptions } = options;

    const handle = mock.intercept(interceptOptions);

    app.provide(SCHMOCK_KEY, mock);

    app.onUnmount(() => {
      handle.restore();
    });
  },
};

// ===== Composable =====

export function useSchmock(): Schmock.CallableMockInstance {
  const mock = inject(SCHMOCK_KEY);
  if (!mock) {
    throw new Error("useSchmock must be used in a component with schmockPlugin installed");
  }
  return mock;
}
```

- [ ] **Step 6: Run unit tests to verify they pass**

Run: `cd packages/vue && bun vitest run`
Expected: All tests PASS.

Note: The `app.onUnmount()` API was introduced in Vue 3.5. If tests fail because the test version lacks it, the cleanup may need to use `app.unmount` event instead. Check Vue version in dev deps and adjust accordingly. An alternative approach is to store the handle and let the consumer call `handle.restore()` manually, or use `onScopeDispose` in a composable pattern. Adjust based on what the Vue test-utils version supports.

- [ ] **Step 7: Write BDD step definitions**

Create `packages/vue/src/steps/vue-adapter.steps.ts`:

```typescript
/// <reference path="../../../core/schmock.d.ts" />

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, vi, afterEach, beforeEach } from "vitest";
import { defineComponent, h, onMounted, ref } from "vue";
import { mount } from "@vue/test-utils";
import { schmock } from "@schmock/core";
import { schmockPlugin, useSchmock } from "../index.js";

const feature = loadFeature("features/vue-adapter.feature");

const UserList = defineComponent({
  setup() {
    const users = ref<Array<{ id: number; name: string }>>([]);

    onMounted(async () => {
      const res = await fetch("http://localhost/api/users");
      users.value = await res.json();
    });

    return () =>
      h(
        "ul",
        users.value.map((u) => h("li", { key: u.id }, u.name)),
      );
  },
});

const MockConsumer = defineComponent({
  setup() {
    const mock = useSchmock();
    return () => h("div", { "data-testid": "has-mock" }, mock ? "yes" : "no");
  },
});

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let originalFetch: typeof globalThis.fetch;
  const fakeFetch = vi.fn().mockResolvedValue(new Response("real"));

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    fakeFetch.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  Scenario("SchmockPlugin intercepts fetch calls", ({ Given, When, Then }) => {
    let wrapper: ReturnType<typeof mount>;

    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock = schmock();
      mock("GET /api/users", [{ id: 1, name: "Alice" }]);
    });

    When("I mount a component that fetches \"/api/users\" with the Schmock plugin", () => {
      wrapper = mount(UserList, {
        global: { plugins: [[schmockPlugin, { mock }]] },
      });
    });

    Then("the component should display the mocked users", async () => {
      await vi.waitFor(() => {
        expect(wrapper.text()).toContain("Alice");
      });
    });
  });

  Scenario("Plugin restores fetch on app unmount", ({ Given, When, Then }) => {
    let savedFetch: typeof globalThis.fetch;

    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock = schmock();
      mock("GET /api/users", [{ id: 1 }]);
    });

    When("I mount and unmount a Vue app with the Schmock plugin", () => {
      savedFetch = globalThis.fetch;
      const wrapper = mount(
        defineComponent({ render: () => h("div") }),
        { global: { plugins: [[schmockPlugin, { mock }]] } },
      );
      wrapper.unmount();
    });

    Then("fetch should be restored to the original implementation", () => {
      expect(globalThis.fetch).toBe(savedFetch);
    });
  });

  Scenario("useSchmock returns the mock instance", ({ Given, When, Then }) => {
    let wrapper: ReturnType<typeof mount>;

    Given("a Schmock instance", () => {
      mock = schmock();
    });

    When("I use the useSchmock composable inside a component with the plugin", () => {
      wrapper = mount(MockConsumer, {
        global: { plugins: [[schmockPlugin, { mock }]] },
      });
    });

    Then("it should receive the CallableMockInstance", () => {
      expect(wrapper.find("[data-testid='has-mock']").text()).toBe("yes");
    });
  });

  Scenario("Passthrough for unmatched routes", ({ Given, When, Then, And }) => {
    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      mock = schmock();
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("the plugin is configured with passthrough enabled", () => {
      mount(
        defineComponent({ render: () => h("div") }),
        {
          global: {
            plugins: [
              [schmockPlugin, { mock, interceptOptions: { passthrough: true } }],
            ],
          },
        },
      );
    });

    When("the component fetches \"/api/other\"", async () => {
      await fetch("http://localhost/api/other");
    });

    Then("the request should pass through to the original fetch", () => {
      expect(fakeFetch).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 8: Run BDD tests**

Run: `cd packages/vue && bun test:bdd`
Expected: All 4 scenarios PASS.

- [ ] **Step 9: Add to root build order and verify**

In root `package.json`, add `@schmock/vue` to the `build` script (before `@schmock/schmock`):

```
... && bun run --filter @schmock/vue build && bun run --filter @schmock/schmock build
```

Run: `bun install && bun run build && bun test:quiet`
Expected: All packages build and all tests pass.

- [ ] **Step 10: Commit**

```bash
git add packages/vue/ features/vue-adapter.feature package.json
git commit -m "feat(vue): add Vue adapter with Plugin and composable

schmockPlugin wraps mock.intercept() with Vue app lifecycle.
useSchmock composable provides access to the mock instance."
```

---

## Final Verification

After all tasks are complete:

- [ ] **Run full test suite from root:** `bun test:quiet`
- [ ] **Run full build:** `bun run build`
- [ ] **Run lint:** `bun lint:quiet`
- [ ] **Verify no regressions in Express and Angular BDD tests**
- [ ] **Verify new packages appear in workspace:** `bun pm ls`
