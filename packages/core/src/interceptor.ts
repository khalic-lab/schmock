/// <reference path="../schmock.d.ts" />

import { awaitWithAbort, throwIfAborted } from "./abort.js";
import {
  canonicalizePath,
  getResponseException,
  isHttpMethod,
  isRouteNotFound,
  matchPathPrefix,
  parsePathPrefix,
} from "./constants.js";
import {
  buildFormattedErrorResponse,
  normalizeResponse,
  serializeResponseBody,
  withDefaultContentType,
} from "./response-normalizer.js";

const PASSTHROUGH = Symbol("schmock.fetch.passthrough");
// A lease whose baseUrl filter rejected the request never reached its handler:
// it was not interested in the request at all, and claimed nothing.
const FILTERED = Symbol("schmock.fetch.filtered");
// A newer lease of the same mock already asked it this exact request, so
// asking again would only repeat the answer and its lifecycle events.
const ALREADY_CONSULTED = Symbol("schmock.fetch.already-consulted");
const RELATIVE_REQUEST_BASE = "http://schmock.invalid/";

/**
 * Where an admission from this module's mock carries its route probe:
 * `(method, path) => boolean`, whether `handle(method, path)` would reach a
 * route, answered from the admission's own snapshot by the resolver handle()
 * uses. Deliberately unregistered: a second copy of `@schmock/core` does not
 * find it and simply reads the body as before.
 */
export const ROUTE_PROBE_KEY = Symbol("schmock.route-probe");

type InterceptorResult =
  | Response
  | typeof PASSTHROUGH
  | typeof FILTERED
  | typeof ALREADY_CONSULTED;

interface NormalizedFetchRequest {
  request: Request;
  url: URL;
  origin: string | null;
}

interface InterceptorRequestOptions extends Schmock.RequestOptions {
  signal: AbortSignal;
}

interface InterceptDispatch {
  request: NormalizedFetchRequest;
  /**
   * Claim the owner's consultation for one effective request (method and
   * path after the lease's own filter and beforeRequest). Returns false when
   * a newer lease of the same mock already asked it exactly this.
   */
  claim(requestKey: string): boolean;
}

interface RegisteredInterceptor {
  token: symbol;
  // Identifies the mock behind the lease. Leases sharing an owner ask it each
  // distinct effective request once; undefined means the lease stands alone.
  owner?: symbol;
  intercept: (dispatch: InterceptDispatch) => Promise<InterceptorResult>;
}

interface FetchResponseContext {
  /** The request method, used for HEAD body stripping. */
  method: string;
  /** The request URL without its fragment, as real fetch reports it. */
  url: string;
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

    // A mock is asked each distinct effective request at most once, however
    // many leases it holds: without this, nested providers on one mock would
    // run handle() — and emit request:start/notfound/end — once per lease.
    // The key is the request each lease would issue after its own baseUrl
    // filter and beforeRequest, so an older lease whose hook rewrites the
    // request (an outer provider stripping "/api") still gets its turn.
    const consultedRequests = new Map<symbol, Set<string>>();
    const claimFor =
      (owner: symbol | undefined) =>
      (requestKey: string): boolean => {
        if (owner === undefined) return true;
        let keys = consultedRequests.get(owner);
        if (keys === undefined) {
          keys = new Set();
          consultedRequests.set(owner, keys);
        }
        if (keys.has(requestKey)) return false;
        keys.add(requestKey);
        return true;
      };

    for (let index = snapshot.length - 1; index >= 0; index -= 1) {
      const registered = snapshot[index];
      const result = await awaitWithAbort(
        registered.intercept({
          request: normalizedRequest,
          claim: claimFor(registered.owner),
        }),
        normalizedRequest.request.signal,
      );
      throwIfAborted(normalizedRequest.request.signal);
      // FILTERED: this lease was not interested, so a sibling lease may be.
      // ALREADY_CONSULTED: the mock already answered this exact request.
      // PASSTHROUGH: the mock has no route for it. All three move on.
      if (
        result === FILTERED ||
        result === ALREADY_CONSULTED ||
        result === PASSTHROUGH
      ) {
        continue;
      }
      return result;
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

interface ExtractedBody {
  value: unknown;
  /** The body claims a JSON media type but does not parse; `value` is its text. */
  malformedJson: boolean;
}

async function extractBody(request: Request): Promise<ExtractedBody> {
  if (request.body === null) return { value: undefined, malformedJson: false };

  const mediaType = normalizeMediaType(request.headers.get("content-type"));
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    return { value: await extractNonJsonBody(request), malformedJson: false };
  }

  const text = await request.clone().text();
  // An empty JSON body is no body at all, as the Node ingress reads it.
  if (text === "") return { value: undefined, malformedJson: false };
  try {
    return { value: JSON.parse(text), malformedJson: false };
  } catch {
    return { value: text, malformedJson: true };
  }
}

async function extractNonJsonBody(request: Request): Promise<unknown> {
  const body = request.clone();
  const mediaType = normalizeMediaType(request.headers.get("content-type"));
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

/** An admission's route probe, when it carries one this module can read. */
function routeProbeOf(
  admission: Schmock.RequestAdmission | undefined,
): ((method: Schmock.HttpMethod, path: string) => boolean) | undefined {
  if (admission === undefined) return undefined;
  const probe: unknown = Reflect.get(admission, ROUTE_PROBE_KEY);
  if (typeof probe !== "function") return undefined;
  // Anything but a definite `false` counts as a route, so an unexpected
  // answer only costs the body read the probe would have saved.
  return (method, path) =>
    Reflect.apply(probe, admission, [method, path]) !== false;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

/**
 * Build the fetch Response from an already-normalized Schmock response.
 */
function createFetchResponse(
  normalized: Schmock.Response,
  context: FetchResponseContext,
): Response {
  const response = new Response(serializeResponseBody(normalized) ?? null, {
    status: normalized.status,
    headers: normalized.headers,
  });
  // A constructed Response has an empty url. Real fetch reports the request
  // URL, and code resolving links with `new URL(next, res.url)` needs it.
  Object.defineProperty(response, "url", { value: context.url });
  return response;
}

function toFetchResponse(
  response: Schmock.Response,
  context: FetchResponseContext,
): Response {
  return createFetchResponse(
    normalizeResponse(withDefaultContentType(response), context.method),
    context,
  );
}

function jsonErrorResponse(input: {
  status: number;
  error: string;
  code: string;
  context: FetchResponseContext;
}): Response {
  return toFetchResponse(
    {
      status: input.status,
      body: { error: input.error, code: input.code },
      headers: { "content-type": "application/json" },
    },
    input.context,
  );
}

/**
 * A request this lease owns but cannot route: pass it on, or answer the same
 * 404 a route miss gets when passthrough is off.
 */
function unroutedResult(
  passthrough: boolean,
  context: FetchResponseContext,
): InterceptorResult {
  if (passthrough) return PASSTHROUGH;
  return jsonErrorResponse({
    status: 404,
    error: "No matching mock route found",
    code: "ROUTE_NOT_FOUND",
    context,
  });
}

/**
 * The fetch Response for an errorFormatter result, built by the shared
 * {@link buildFormattedErrorResponse}. TOTAL: it never throws, and the
 * formatter runs exactly once. It runs inside the interceptor's `try`, so an
 * escaping error would land in the catch below and invoke the formatter a
 * second time.
 */
function formattedErrorResponse(input: {
  formatter: (error: Error) => unknown;
  error: Error;
  responseHeaders?: Record<string, string>;
  context: FetchResponseContext;
}): Response {
  return createFetchResponse(
    buildFormattedErrorResponse({
      formatter: input.formatter,
      error: input.error,
      inheritedHeaders: input.responseHeaders,
      method: input.context.method,
    }),
    input.context,
  );
}

/** Fetch reports the request URL without its fragment. */
function responseUrlOf(url: URL): string {
  const responseUrl = new URL(url.href);
  responseUrl.hash = "";
  return responseUrl.href;
}

function effectiveRequestKey(method: string, path: string): string {
  return `${method} ${canonicalizePath(path)}`;
}

/**
 * Create a fetch interceptor that routes requests through mock.handle().
 *
 * `owner` identifies the mock behind the lease. Leases sharing an owner ask it
 * each distinct effective request (method and path after the lease's own
 * beforeRequest) at most once, so a mock held by several leases runs its
 * handler — and emits its lifecycle events — once per request it is asked.
 */
export function createFetchInterceptor(
  handle: Schmock.MockRequestHandler,
  options: Schmock.InterceptOptions = {},
  admitRequest?: () => Schmock.RequestAdmission,
  owner?: symbol,
): Schmock.InterceptHandle {
  // The options live in a mutable cell that each request reads once at its
  // start. Reconfiguring a lease in place is what lets an adapter apply new
  // hooks without re-registering — re-registration would move the lease to the
  // front of the dispatch order and steal precedence from other mocks.
  let currentOptions: Schmock.InterceptOptions = options;

  return registerInterceptor(
    async ({
      request: { request, url, origin },
      claim,
    }): Promise<InterceptorResult> => {
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
        const base = parsePathPrefix(baseUrl);
        if (base.origin && origin !== base.origin) {
          return FILTERED;
        }
        if (!matchPathPrefix(base, path)) {
          return FILTERED;
        }
      }

      throwIfAborted(request.signal);
      const context: FetchResponseContext = {
        method: request.method,
        url: responseUrlOf(url),
      };
      // No route can ever match a method outside the supported set (WebDAV's
      // PROPFIND, a CDN PURGE), so it is a miss like any other rather than a
      // rejected fetch. Checked before admission, which it never needs.
      const initialMethod = request.method.toUpperCase();
      if (!isHttpMethod(initialMethod)) {
        return unroutedResult(passthrough, context);
      }
      context.method = initialMethod;
      const admission = admitRequest?.();
      const admittedHandle = admission?.handle ?? handle;
      // Without a beforeRequest hook (which receives the body and may change
      // the method or path), the request handle() will see is already known,
      // so a passthrough lease asks the admission whether any route answers
      // it. On a definite miss the body is never read: the request reaches
      // the network untouched, and handle() still runs, without a body, so
      // request:start/notfound/end are emitted exactly as before.
      const routeProbe =
        passthrough && !beforeRequest ? routeProbeOf(admission) : undefined;
      // The request handed to errorFormatter: the latest one this lease built,
      // so it reflects beforeRequest once that hook has returned.
      let formatterRequest: Schmock.AdapterRequest | undefined;

      try {
        const body: ExtractedBody =
          routeProbe !== undefined && !routeProbe(initialMethod, path)
            ? { value: undefined, malformedJson: false }
            : await awaitWithAbort(extractBody(request), request.signal);
        throwIfAborted(request.signal);

        // With passthrough off the lease owns every request that reaches it,
        // as the Node server does, so a JSON body that does not parse gets
        // the server's 400 before any route runs or history records it.
        if (body.malformedJson && !passthrough) {
          return jsonErrorResponse({
            status: 400,
            error: "Malformed JSON request body",
            code: "MALFORMED_JSON",
            context,
          });
        }

        let adapterRequest: Schmock.AdapterRequest = {
          method: request.method,
          path,
          headers: extractHeaders(request),
          body: body.value,
          query: extractQuery(url),
        };
        formatterRequest = adapterRequest;

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
            formatterRequest = modified;
          }
        }

        throwIfAborted(request.signal);
        // A hook may produce a method no route can match; that is a miss
        // too, as the Angular adapter treats it.
        const effectiveMethod = adapterRequest.method.toUpperCase();
        if (!isHttpMethod(effectiveMethod)) {
          return unroutedResult(passthrough, context);
        }
        context.method = effectiveMethod;

        if (!claim(effectiveRequestKey(effectiveMethod, adapterRequest.path))) {
          return ALREADY_CONSULTED;
        }

        const requestOptions: InterceptorRequestOptions = {
          headers: adapterRequest.headers,
          body: adapterRequest.body,
          query: adapterRequest.query,
          signal: request.signal,
        };
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
          return unroutedResult(passthrough, context);
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
          const seenRequest = adapterRequest;
          return formattedErrorResponse({
            formatter: (error) => errorFormatter(error, seenRequest),
            error: internalError,
            responseHeaders: response.headers,
            context,
          });
        }

        // An admission's handle() already normalized its own output for this
        // method; with no hook to replace or mutate it, a second pass would
        // only re-validate the same tree. Anything else is re-normalized.
        if (admission !== undefined && beforeResponse === undefined) {
          return createFetchResponse(
            withDefaultContentType(schmockResponse),
            context,
          );
        }
        return toFetchResponse(response, context);
      } catch (error) {
        throwIfAborted(request.signal);
        if (isAbortError(error)) {
          throw error;
        }
        if (errorFormatter) {
          // A formatter that throws here propagates and rejects the fetch; a
          // body it returns that cannot be serialized falls back to the same
          // INTERNAL_ERROR body the core-marked path uses.
          const failure =
            error instanceof Error ? error : new Error(String(error));
          // No request was built when the body itself could not be read.
          const formatted = errorFormatter(
            failure,
            formatterRequest ?? {
              method: request.method,
              path,
              headers: extractHeaders(request),
              query: extractQuery(url),
            },
          );
          throwIfAborted(request.signal);
          return formattedErrorResponse({
            formatter: () => formatted,
            error: failure,
            context,
          });
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
