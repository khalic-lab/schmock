/// <reference path="../schmock.d.ts" />

import { awaitWithAbort, throwIfAborted } from "./abort.js";
import { isBinaryBody } from "./binary.js";
import {
  canonicalizePath,
  getResponseException,
  isRouteNotFound,
  toHttpMethod,
} from "./constants.js";
import {
  normalizeResponse,
  serializeResponseBody,
} from "./response-normalizer.js";

const PASSTHROUGH = Symbol("schmock.fetch.passthrough");
// A lease whose baseUrl filter rejected the request never reached its handler.
// It is distinct from PASSTHROUGH so the dispatch loop can tell "this owner
// already ran" from "this lease was not interested in the request at all".
const FILTERED = Symbol("schmock.fetch.filtered");
const RELATIVE_REQUEST_BASE = "http://schmock.invalid/";

type InterceptorResult = Response | typeof PASSTHROUGH | typeof FILTERED;

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
  // Identifies the mock behind the lease. Leases sharing an owner share one
  // consultation per request; undefined means the lease stands alone.
  owner?: symbol;
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

    // A mock is consulted at most once per request, however many leases it
    // holds: without this, nested providers on one mock would run handle()
    // — and emit request:start/notfound/end — once per lease.
    const consultedOwners = new Set<symbol>();

    for (let index = snapshot.length - 1; index >= 0; index -= 1) {
      const registered = snapshot[index];
      const { owner } = registered;
      if (owner !== undefined && consultedOwners.has(owner)) {
        continue;
      }

      const result = await awaitWithAbort(
        registered.intercept(normalizedRequest),
        normalizedRequest.request.signal,
      );
      throwIfAborted(normalizedRequest.request.signal);
      // The lease filtered the request out before admission, so its owner
      // keeps its turn — a sibling lease may carry a matching baseUrl.
      if (result === FILTERED) {
        continue;
      }
      if (result !== PASSTHROUGH) {
        return result;
      }
      if (owner !== undefined) {
        consultedOwners.add(owner);
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
  applyOptions: (options?: Schmock.InterceptOptions) => void,
  owner?: symbol,
): Schmock.InterceptHandle {
  let session = activeSession;
  if (!session || globalThis.fetch !== session.dispatchFetch) {
    session = createInterceptorSession();
    activeSession = session;
    globalThis.fetch = session.dispatchFetch;
  }

  const token = Symbol("schmock.fetch.interceptor");
  session.interceptors.push({ token, owner, intercept });
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
    update(options) {
      // Reconfiguring never touches session.interceptors, so the lease keeps
      // the dispatch position it was registered with.
      if (!active) return;
      applyOptions(options);
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
      const canonicalPath = canonicalizePath(parsed.pathname);
      const path =
        canonicalPath === "/" ? "" : canonicalPath.replace(/\/$/, "");
      return { origin: parsed.origin, path };
    } catch {
      // Fall through to path-only handling
    }
  }
  const canonicalPath = canonicalizePath(baseUrl);
  const path = canonicalPath === "/" ? "" : canonicalPath.replace(/\/$/, "");
  return { origin: null, path };
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
 * Formatted error bodies are always JSON, so the replaced response's own
 * content type must be dropped rather than inherited. Every case variant goes
 * first: leaving a `Content-Type` beside the forced lowercase key makes the
 * pair transport-invalid and the normalizer rejects it.
 */
function withJsonContentType(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === "content-type") continue;
    result[name] = value;
  }
  result["content-type"] = "application/json";
  return result;
}

/**
 * Invoke the errorFormatter for a core-marked exception and build its
 * response, falling back to a minimal safe body when the formatter throws or
 * its result is not serializable.
 *
 * This helper is TOTAL — it never throws. It runs inside the interceptor's
 * `try`, so an escaping error would land in the catch below and invoke the
 * formatter a second time; the re-entrancy is exactly the defect the Express
 * adapter's `sendFormattedError` was shaped to avoid.
 *
 * `responseHeaders` carries the (post-hook) headers of the response being
 * replaced so metadata such as `retry-after` survives. There are two distinct
 * fallbacks. When the inherited headers are untransportable, the send is
 * retried once with the fixed JSON header set and the SAME formatted body —
 * nothing is on the wire yet, and losing the body would silently change the
 * user's error contract. Only a failure of the formatter itself, or of its
 * body, reaches the minimal fallback, which deliberately inherits nothing.
 */
function formatInterceptedError(
  errorFormatter: (error: Error) => unknown,
  error: Error,
  responseHeaders: Record<string, string> | undefined,
  method: Schmock.HttpMethod,
): Response {
  try {
    const formatted = errorFormatter(error);
    try {
      return toFetchResponse(
        {
          status: 500,
          body: formatted,
          headers: withJsonContentType(responseHeaders),
        },
        method,
      );
    } catch {
      // `formatted` is reused, so the formatter still fires exactly once.
      return toFetchResponse(
        {
          status: 500,
          body: formatted,
          headers: { "content-type": "application/json" },
        },
        method,
      );
    }
  } catch {
    return toFetchResponse(
      {
        status: 500,
        body: { error: "Internal Server Error", code: "INTERNAL_ERROR" },
        headers: { "content-type": "application/json" },
      },
      method,
    );
  }
}

/**
 * Create a fetch interceptor that routes requests through mock.handle().
 *
 * `owner` identifies the mock behind the lease. Leases sharing an owner are
 * consulted at most once per request, so a mock held by several leases runs
 * its handler — and emits its lifecycle events — once per network request.
 */
export function createFetchInterceptor(
  handle: InterceptRequestHandler,
  options: Schmock.InterceptOptions = {},
  admitRequest?: () => InterceptRequestAdmission,
  owner?: symbol,
): Schmock.InterceptHandle {
  // The options live in a mutable cell that each request reads once at its
  // start. Reconfiguring a lease in place is what lets an adapter apply new
  // hooks without re-registering — re-registration would move the lease to the
  // front of the dispatch order and steal precedence from other mocks.
  let currentOptions: Schmock.InterceptOptions = options;

  return registerInterceptor(
    async ({ request, url, origin }): Promise<InterceptorResult> => {
      const {
        baseUrl,
        passthrough = true,
        beforeRequest,
        beforeResponse,
        errorFormatter,
      } = currentOptions;
      const path = canonicalizePath(url.pathname);

      // BaseUrl filter — non-matching requests go straight to real fetch.
      // Two modes:
      //   - origin form ("https://api.example.com/v1"): require matching
      //     origin AND matching path prefix.
      //   - path form ("/api"): match pathname prefix only.
      // Both enforce a segment boundary so "/api" doesn't match "/apiv2".
      if (baseUrl) {
        const { origin: baseOrigin, path: basePath } = parseBaseUrl(baseUrl);
        if (baseOrigin && origin !== baseOrigin) {
          return FILTERED;
        }
        if (basePath) {
          const isMatch = path === basePath || path.startsWith(`${basePath}/`);
          if (!isMatch) {
            return FILTERED;
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

        // Exception provenance is carried on the response as a non-enumerable
        // symbol, so it must be read BEFORE beforeResponse runs: the
        // documented `{...response}` hook pattern copies only own enumerable
        // properties and would otherwise strip the mark, silently bypassing
        // errorFormatter.
        const internalError = getResponseException(schmockResponse);

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

        // Only core-marked exceptions reach errorFormatter; a user-defined 500
        // with an error-shaped body stays an ordinary domain response. The
        // POST-hook status gates the replacement (matching Express and
        // Angular): a beforeResponse that rewrites an exception into a 503 or
        // a 200 is honoured instead of being forced back to a formatted 500.
        if (errorFormatter && internalError && response.status === 500) {
          return formatInterceptedError(
            errorFormatter,
            internalError,
            response.headers,
            effectiveMethod,
          );
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
    (nextOptions) => {
      currentOptions = nextOptions ?? {};
    },
    owner,
  );
}
