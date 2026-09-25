import type * as Schmock from "@schmock/core";
import { isStatusTuple } from "@schmock/core";
import { generateFromSchema } from "@schmock/faker";
import type { ParsedCallback } from "./parser.js";
import { getHeader } from "./request-pipeline.js";
import { isRecord } from "./utils.js";

// Type-safe route config accessor for callbacks
export function getRouteCallbacks(
  route: Schmock.RouteConfig,
): ParsedCallback[] | undefined {
  const value = route["openapi:callbacks"];
  return Array.isArray(value) ? value : undefined;
}

/**
 * Resolve and deliver callbacks through the application-owned dispatcher.
 * Schmock deliberately performs no network I/O itself.
 *
 * The dispatched payload is generated from the callback operation's own
 * declared request body. Only when the callback declares no request body does
 * it fall back to the primary endpoint's response body.
 *
 * A callback whose URL expression cannot be fully resolved is skipped rather
 * than dispatched to a partial URL. That is usually a client that did not opt
 * in (no `callbackUrl` in the body), so the skip is only logged when `debug`
 * is on.
 */
export async function dispatchCallbacks(
  callbacks: ParsedCallback[],
  dispatcher: Schmock.OpenApiCallbackOptions["dispatch"],
  context: Schmock.PluginContext,
  response: unknown,
  seed?: number,
  debug = false,
): Promise<void> {
  for (const callback of callbacks) {
    const resolved = resolveCallbackUrl(
      callback.urlExpression,
      context,
      response,
    );
    if (resolved.unresolved !== undefined) {
      if (!debug) continue;
      console.warn(
        `[@schmock/openapi] Callback ${callback.method} ${callback.urlExpression} skipped: could not resolve {$${resolved.unresolved}} to a string, number or boolean`,
      );
      continue;
    }
    const url = resolved.url;
    if (!url) continue;

    let body: unknown;
    if (callback.requestBody) {
      try {
        body = await generateFromSchema({ schema: callback.requestBody, seed });
      } catch (error) {
        console.warn(
          `[@schmock/openapi] Callback body generation failed for ${callback.method} ${url}:`,
          error instanceof Error ? error.message : error,
        );
        continue;
      }
    } else {
      body = getResponseBody(response);
    }

    try {
      await dispatcher({
        url,
        method: callback.method,
        headers: { "content-type": "application/json" },
        body,
      });
    } catch (error) {
      console.warn(
        `[@schmock/openapi] Callback dispatcher failed for ${callback.method} ${url}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

type ResolvedCallbackUrl =
  | { url: string; unresolved?: undefined }
  | { url?: undefined; unresolved: string };

/**
 * The URL text a runtime value contributes, or undefined when it has none.
 *
 * Numbers and booleans are stringified: CRUD mints integer ids by default, and
 * the OpenAPI spec's own callback example embeds `{$response.body#/id}`. A
 * missing value, `null`, an object or an array has no URL form.
 */
function urlSegment(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Resolve a callback URL expression using runtime values.
 * Handles expressions like "{$request.body#/callbackUrl}" and literal URLs.
 *
 * A request/response expression that yields no usable value makes the whole
 * URL unresolved, reported by the expression text: splicing `""` in its place
 * used to dispatch a partial URL such as `https://hooks.example/pets/`.
 */
function resolveCallbackUrl(
  expression: string,
  context: Schmock.PluginContext,
  response: unknown,
): ResolvedCallbackUrl {
  let unresolved: string | undefined;
  const url = expression.replace(/\{\$([^}]+)\}/g, (_, expr: string) => {
    const segment = resolveExpression(expr, context, response);
    if (segment === undefined) {
      unresolved ??= expr;
      return "";
    }
    return segment;
  });
  return unresolved === undefined ? { url } : { unresolved };
}

/**
 * One runtime expression's value. Returns undefined for a request/response
 * expression that resolves to nothing usable, and `""` for an expression kind
 * this resolver does not implement (`$url`, `$method`, `$statusCode`, …).
 */
function resolveExpression(
  expr: string,
  context: Schmock.PluginContext,
  response: unknown,
): string | undefined {
  // $request.body#/path — JSON pointer into request body
  if (expr.startsWith("request.body#")) {
    const pointer = expr.slice("request.body#".length);
    return urlSegment(resolveJsonPointer(context.body, pointer));
  }

  // $request.header.name — case-insensitive: core does not normalize header
  // case on a direct `mock.handle` call.
  if (expr.startsWith("request.header.")) {
    const headerName = expr.slice("request.header.".length);
    return getHeader(context.headers, headerName);
  }

  // $request.query.name
  if (expr.startsWith("request.query.")) {
    const queryName = expr.slice("request.query.".length);
    return Object.hasOwn(context.query, queryName)
      ? context.query[queryName]
      : undefined;
  }

  // $request.path.param
  if (expr.startsWith("request.path.")) {
    const paramName = expr.slice("request.path.".length);
    return Object.hasOwn(context.params, paramName)
      ? context.params[paramName]
      : undefined;
  }

  // $response.body#/path — JSON pointer into response body
  if (expr.startsWith("response.body#")) {
    const pointer = expr.slice("response.body#".length);
    return urlSegment(resolveJsonPointer(getResponseBody(response), pointer));
  }

  return "";
}

function getResponseBody(response: unknown): unknown {
  if (isStatusTuple(response)) return response[1];
  if (
    isRecord(response) &&
    typeof response.status === "number" &&
    "body" in response
  ) {
    return response.body;
  }
  return response;
}

function resolveJsonPointer(obj: unknown, pointer: string): unknown {
  if (pointer === "") return obj;
  if (!pointer.startsWith("/")) return undefined;

  const parts = pointer.slice(1).split("/");
  let current: unknown = obj;
  for (const encodedPart of parts) {
    if (/~(?:[^01]|$)/.test(encodedPart)) return undefined;
    const part = encodedPart.replace(/~1/g, "/").replace(/~0/g, "~");

    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(part)) return undefined;
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (!isRecord(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}
