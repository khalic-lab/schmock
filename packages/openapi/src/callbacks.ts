import type * as Schmock from "@schmock/core";
import { isStatusTuple } from "@schmock/core";
import { generateFromSchema } from "@schmock/faker";
import type { ParsedCallback } from "./parser.js";
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
 */
export async function dispatchCallbacks(
  callbacks: ParsedCallback[],
  dispatcher: Schmock.OpenApiCallbackOptions["dispatch"],
  context: Schmock.PluginContext,
  response: unknown,
  seed?: number,
): Promise<void> {
  for (const callback of callbacks) {
    const url = resolveCallbackUrl(callback.urlExpression, context, response);
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

/**
 * Resolve a callback URL expression using runtime values.
 * Handles expressions like "{$request.body#/callbackUrl}" and literal URLs.
 */
function resolveCallbackUrl(
  expression: string,
  context: Schmock.PluginContext,
  response: unknown,
): string | undefined {
  // Replace all runtime expression tokens
  return expression.replace(/\{\$([^}]+)\}/g, (_, expr: string) => {
    // $request.body#/path — JSON pointer into request body
    if (expr.startsWith("request.body#")) {
      const pointer = expr.slice("request.body#".length);
      const value = resolveJsonPointer(context.body, pointer);
      return typeof value === "string" ? value : "";
    }

    // $request.header.name
    if (expr.startsWith("request.header.")) {
      const headerName = expr.slice("request.header.".length).toLowerCase();
      return context.headers[headerName] ?? "";
    }

    // $request.query.name
    if (expr.startsWith("request.query.")) {
      const queryName = expr.slice("request.query.".length);
      return context.query[queryName] ?? "";
    }

    // $request.path.param
    if (expr.startsWith("request.path.")) {
      const paramName = expr.slice("request.path.".length);
      return context.params[paramName] ?? "";
    }

    // $response.body#/path — JSON pointer into response body
    if (expr.startsWith("response.body#")) {
      const pointer = expr.slice("response.body#".length);
      const responseBody = getResponseBody(response);
      const value = resolveJsonPointer(responseBody, pointer);
      return typeof value === "string" ? value : "";
    }

    return "";
  });
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
