/// <reference path="../schmock.d.ts" />

import { isRouteNotFound, toHttpMethod } from "./constants.js";

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
 * Extract origin (scheme + host + port) from a URL string, or null for
 * relative URLs that don't carry one.
 */
function extractOrigin(url: string): string | null {
  if (!url.includes("://")) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Parse the user-supplied baseUrl option into its origin and path parts.
 * - "/api"                  → { origin: null, path: "/api" }
 * - "https://x.com/api/v1"  → { origin: "https://x.com", path: "/api/v1" }
 * - "https://x.com"         → { origin: "https://x.com", path: "" }
 *
 * Trailing slash is stripped from the path so the segment-boundary check
 * works the same way for "/api" and "/api/".
 */
function parseBaseUrl(baseUrl: string): {
  origin: string | null;
  path: string;
} {
  if (baseUrl.includes("://")) {
    try {
      const parsed = new URL(baseUrl);
      const rawPath = parsed.pathname;
      const path = rawPath === "/" ? "" : rawPath.replace(/\/$/, "");
      return { origin: parsed.origin, path };
    } catch {
      // Fall through to path-only handling
    }
  }
  return { origin: null, path: baseUrl.replace(/\/$/, "") };
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

  const raw =
    init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (!raw) return headers;

  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(raw)) {
    for (const [key, value] of raw) {
      headers[key.toLowerCase()] = value;
    }
  } else {
    for (const key of Object.keys(raw)) {
      headers[key.toLowerCase()] = (raw as Record<string, string>)[key];
    }
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
  // Per Fetch spec, init.body overrides Request.body when both are present
  const bodyInit = init?.body ?? (input instanceof Request ? input.body : null);
  if (bodyInit === null || bodyInit === undefined) return undefined;

  // String body — try to parse as JSON
  if (typeof bodyInit === "string") {
    try {
      return JSON.parse(bodyInit);
    } catch {
      return bodyInit;
    }
  }

  // URLSearchParams — convert to key/value object
  if (bodyInit instanceof URLSearchParams) {
    const result: Record<string, string> = {};
    bodyInit.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  // Request with body — clone and read
  if (input instanceof Request && !init?.body && input.body) {
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
    requestOptions?: Schmock.RequestOptions,
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

    // BaseUrl filter — non-matching requests go straight to real fetch.
    // Two modes:
    //   - origin form ("https://api.example.com/v1"): require matching
    //     origin AND matching path prefix.
    //   - path form ("/api"): match pathname prefix only.
    // Both enforce a segment boundary so "/api" doesn't match "/apiv2".
    if (baseUrl) {
      const { origin: baseOrigin, path: basePath } = parseBaseUrl(baseUrl);
      if (baseOrigin) {
        const reqOrigin = extractOrigin(urlString);
        if (reqOrigin !== baseOrigin) {
          return originalFetch(input, init);
        }
      }
      if (basePath) {
        const isMatch = path === basePath || path.startsWith(`${basePath}/`);
        if (!isMatch) {
          return originalFetch(input, init);
        }
      }
    }

    // Build adapter request
    const method =
      input instanceof Request ? input.method : (init?.method ?? "GET");
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

    try {
      // Apply beforeRequest hook
      if (beforeRequest) {
        const modified = await beforeRequest(adapterRequest);
        if (modified) {
          adapterRequest = modified;
        }
      }

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
