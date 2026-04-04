/// <reference path="../../core/schmock.d.ts" />

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
 * Fire callbacks in a fire-and-forget manner.
 * Silently ignores failures — callbacks are best-effort.
 */
export function fireCallbacks(
  callbacks: ParsedCallback[],
  context: Schmock.PluginContext,
  response: unknown,
): void {
  for (const callback of callbacks) {
    const url = resolveCallbackUrl(callback.urlExpression, context, response);
    if (!url?.startsWith("http")) continue;

    const body = Array.isArray(response) ? response[1] : response;

    // Fire and forget
    void fetch(url, {
      method: callback.method,
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).catch((error: unknown) => {
      console.warn(
        `[@schmock/openapi] Callback ${callback.method} ${url} failed:`,
        error instanceof Error ? error.message : error,
      );
    });
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
      const responseBody = Array.isArray(response) ? response[1] : response;
      const value = resolveJsonPointer(responseBody, pointer);
      return typeof value === "string" ? value : "";
    }

    return "";
  });
}

function resolveJsonPointer(obj: unknown, pointer: string): unknown {
  if (!isRecord(obj) || !pointer.startsWith("/")) return undefined;

  const parts = pointer.slice(1).split("/");
  let current: unknown = obj;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}
