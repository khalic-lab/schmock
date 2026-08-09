/// <reference path="../schmock.d.ts" />

import { awaitWithAbort, throwIfAborted } from "./abort.js";
import { isBinaryBody } from "./binary.js";
import { isRouteNotFound, toHttpMethod } from "./constants.js";
import {
  normalizeResponse,
  serializeResponseBody,
} from "./response-normalizer.js";

const PASSTHROUGH = Symbol("schmock.fetch.passthrough");
const RELATIVE_REQUEST_BASE = "http://schmock.invalid/";

type InterceptorResult = Response | typeof PASSTHROUGH;

interface NormalizedFetchRequest {
  request: Request;
  url: URL;
  origin: string | null;
}

interface InterceptorRequestOptions extends Schmock.RequestOptions {
  signal: AbortSignal;
}

type InterceptRequestHandler = (
  method: Schmock.HttpMethod,
  path: string,
  requestOptions?: Schmock.RequestOptions,
) => Promise<Schmock.Response>;

interface RegisteredInterceptor {
  token: symbol;
  intercept: (request: NormalizedFetchRequest) => Promise<InterceptorResult>;
}

interface InterceptRequestAdmission {
  handle: InterceptRequestHandler;
  release(): void;
}

interface InterceptorSession {
  baselineFetch: typeof globalThis.fetch;
  dispatchFetch: typeof globalThis.fetch;
  interceptors: RegisteredInterceptor[];
}

let activeSession: InterceptorSession | undefined;

function getRelativeRequestBase(): string {
  const candidates = [
    typeof document === "undefined" ? undefined : document.baseURI,
    typeof location === "undefined" ? undefined : location.href,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return new URL(candidate).href;
    } catch {
      // Ignore invalid environment globals and use the next fallback.
    }
  }
  return RELATIVE_REQUEST_BASE;
}

// The Fetch standard stamps a content type when the body is extracted from a
// string or URLSearchParams. Node's Request constructor conforms; Bun's omits
// the header, so identical consumer code would otherwise deliver a string
// body on Node and an opaque ArrayBuffer on Bun.
function stampBodyContentType(
  request: Request,
  body: BodyInit | null | undefined,
): void {
  if (body == null || request.headers.has("content-type")) return;
  if (typeof body === "string") {
    request.headers.set("content-type", "text/plain;charset=UTF-8");
  } else if (body instanceof URLSearchParams) {
    request.headers.set(
      "content-type",
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
  }
}

function normalizeFetchRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): NormalizedFetchRequest {
  if (input instanceof Request) {
    // Constructing a Request from another Request transfers its body. Use a
    // clone when the body is inherited so the original remains passthrough-safe.
    const source = init?.body == null ? input.clone() : input;
    const request = new Request(source, init);
    if (init?.body != null) {
      stampBodyContentType(request, init.body);
    } else if (request.body != null && !request.headers.has("content-type")) {
      // The body was inherited from the input Request, but init.headers
      // replaces the whole header list, dropping the content type stamped
      // when that body was extracted. Restore it so the handler still sees
      // the body as its original kind. (Bun never stamps at construction,
      // so a string body on a type-less input Request stays opaque there.)
      const inheritedType = input.headers.get("content-type");
      if (inheritedType !== null) {
        request.headers.set("content-type", inheritedType);
      }
    }
    const url = new URL(request.url);
    return {
      request,
      url,
      origin: url.origin,
    };
  }

  if (input instanceof URL) {
    const request = new Request(input, init);
    stampBodyContentType(request, init?.body);
    const url = new URL(request.url);
    return {
      request,
      url,
      origin: url.origin,
    };
  }

  let inputUrl: URL;
  let origin: string | null;
  try {
    inputUrl = new URL(input);
    origin = inputUrl.origin;
  } catch {
    inputUrl = new URL(input, getRelativeRequestBase());
    origin = null;
  }

  const request = new Request(inputUrl, init);
  stampBodyContentType(request, init?.body);
  return {
    request,
    url: new URL(request.url),
    origin,
  };
}

function createInterceptorSession(): InterceptorSession {
  const baselineFetch = globalThis.fetch;
  const interceptors: RegisteredInterceptor[] = [];
  const dispatchFetch: typeof globalThis.fetch = async (input, init) => {
    const snapshot = interceptors.slice();
    if (snapshot.length === 0) {
      return baselineFetch(input, init);
    }

    const normalizedRequest = normalizeFetchRequest(input, init);
    throwIfAborted(normalizedRequest.request.signal);

    for (let index = snapshot.length - 1; index >= 0; index -= 1) {
      const result = await awaitWithAbort(
        snapshot[index].intercept(normalizedRequest),
        normalizedRequest.request.signal,
      );
      throwIfAborted(normalizedRequest.request.signal);
      if (result !== PASSTHROUGH) {
        return result;
      }
    }

    return awaitWithAbort(
      baselineFetch(normalizedRequest.request),
      normalizedRequest.request.signal,
    );
  };

  return { baselineFetch, dispatchFetch, interceptors };
}

function registerInterceptor(
  intercept: RegisteredInterceptor["intercept"],
): Schmock.InterceptHandle {
  let session = activeSession;
  if (!session || globalThis.fetch !== session.dispatchFetch) {
    session = createInterceptorSession();
    activeSession = session;
    globalThis.fetch = session.dispatchFetch;
  }

  const token = Symbol("schmock.fetch.interceptor");
  session.interceptors.push({ token, intercept });
  let active = true;

  return {
    restore() {
      if (!active) return;

      active = false;
      const index = session.interceptors.findIndex(
        (entry) => entry.token === token,
      );
      if (index !== -1) {
        session.interceptors.splice(index, 1);
      }

      if (session.interceptors.length !== 0) return;
      if (activeSession === session) {
        activeSession = undefined;
      }

      // A library may have installed its own fetch wrapper after Schmock. Its
      // replacement is now the current owner and must not be overwritten.
      if (globalThis.fetch === session.dispatchFetch) {
        globalThis.fetch = session.baselineFetch;
      }
    },
    get active() {
      return active;
    },
  };
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

function extractQuery(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams);
}

function extractHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

function normalizeMediaType(contentType: string | null): string {
  return contentType?.split(";", 1)[0].trim().toLowerCase() ?? "";
}

async function extractBody(request: Request): Promise<unknown> {
  if (request.body === null) return undefined;

  const body = request.clone();
  const mediaType = normalizeMediaType(request.headers.get("content-type"));
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    const text = await body.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (mediaType === "application/x-www-form-urlencoded") {
    return Object.fromEntries(new URLSearchParams(await body.text()));
  }
  if (mediaType.startsWith("text/")) {
    return body.text();
  }
  if (mediaType.startsWith("multipart/")) {
    return body.formData();
  }
  return body.arrayBuffer();
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function toFetchResponse(
  response: Schmock.Response,
  method: Schmock.HttpMethod,
): Response {
  const headers = { ...response.headers };
  const hasContentType = Object.keys(headers).some(
    (name) => name.toLowerCase() === "content-type",
  );
  if (
    !hasContentType &&
    response.body !== null &&
    response.body !== undefined
  ) {
    if (isBinaryBody(response.body)) {
      headers["content-type"] = "application/octet-stream";
    } else if (typeof response.body !== "string") {
      headers["content-type"] = "application/json";
    }
  }

  const normalized = normalizeResponse({ ...response, headers }, method);
  return new Response(serializeResponseBody(normalized) ?? null, {
    status: normalized.status,
    headers: normalized.headers,
  });
}

/**
 * Create a fetch interceptor that routes requests through mock.handle().
 */
export function createFetchInterceptor(
  handle: InterceptRequestHandler,
  options: Schmock.InterceptOptions = {},
  admitRequest?: () => InterceptRequestAdmission,
): Schmock.InterceptHandle {
  const {
    baseUrl,
    passthrough = true,
    beforeRequest,
    beforeResponse,
    errorFormatter,
  } = options;

  return registerInterceptor(
    async ({ request, url, origin }): Promise<InterceptorResult> => {
      const path = url.pathname;

      // BaseUrl filter — non-matching requests go straight to real fetch.
      // Two modes:
      //   - origin form ("https://api.example.com/v1"): require matching
      //     origin AND matching path prefix.
      //   - path form ("/api"): match pathname prefix only.
      // Both enforce a segment boundary so "/api" doesn't match "/apiv2".
      if (baseUrl) {
        const { origin: baseOrigin, path: basePath } = parseBaseUrl(baseUrl);
        if (baseOrigin && origin !== baseOrigin) {
          return PASSTHROUGH;
        }
        if (basePath) {
          const isMatch = path === basePath || path.startsWith(`${basePath}/`);
          if (!isMatch) {
            return PASSTHROUGH;
          }
        }
      }

      throwIfAborted(request.signal);
      const initialMethod = toHttpMethod(request.method);
      const admission = admitRequest?.();
      const admittedHandle = admission?.handle ?? handle;
      let effectiveMethod = initialMethod;

      try {
        const body = await awaitWithAbort(extractBody(request), request.signal);
        throwIfAborted(request.signal);

        let adapterRequest: Schmock.AdapterRequest = {
          method: request.method,
          path,
          headers: extractHeaders(request),
          body,
          query: extractQuery(url),
        };

        // Apply beforeRequest hook
        if (beforeRequest) {
          throwIfAborted(request.signal);
          const modified = await awaitWithAbort(
            beforeRequest(adapterRequest),
            request.signal,
          );
          throwIfAborted(request.signal);
          if (modified) {
            adapterRequest = modified;
          }
        }

        throwIfAborted(request.signal);
        const requestOptions: InterceptorRequestOptions = {
          headers: adapterRequest.headers,
          body: adapterRequest.body,
          query: adapterRequest.query,
          signal: request.signal,
        };
        effectiveMethod = toHttpMethod(adapterRequest.method);
        const schmockResponse = await awaitWithAbort(
          admittedHandle(effectiveMethod, adapterRequest.path, requestOptions),
          request.signal,
        );
        throwIfAborted(request.signal);

        // Route not found — passthrough or 404
        if (isRouteNotFound(schmockResponse)) {
          if (passthrough) {
            return PASSTHROUGH;
          }
          return toFetchResponse(
            {
              status: 404,
              body: {
                error: "No matching mock route found",
                code: "ROUTE_NOT_FOUND",
              },
              headers: { "content-type": "application/json" },
            },
            effectiveMethod,
          );
        }

        // Apply beforeResponse hook
        let response: Schmock.AdapterResponse = schmockResponse;
        if (beforeResponse) {
          throwIfAborted(request.signal);
          const modified = await awaitWithAbort(
            beforeResponse(response, adapterRequest),
            request.signal,
          );
          throwIfAborted(request.signal);
          if (modified) {
            response = modified;
          }
        }

        return toFetchResponse(response, effectiveMethod);
      } catch (error) {
        throwIfAborted(request.signal);
        if (isAbortError(error)) {
          throw error;
        }
        if (errorFormatter) {
          const formatted = errorFormatter(
            error instanceof Error ? error : new Error(String(error)),
          );
          throwIfAborted(request.signal);
          return toFetchResponse(
            {
              status: 500,
              body: formatted,
              headers: { "content-type": "application/json" },
            },
            effectiveMethod,
          );
        }
        throw error;
      } finally {
        admission?.release();
      }
    },
  );
}
