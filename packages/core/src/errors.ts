/** Longest stringification of a non-Error throw kept in a message. */
const MAX_THROWN_VALUE_LENGTH = 200;

function truncateThrownValue(text: string): string {
  return text.length > MAX_THROWN_VALUE_LENGTH
    ? `${text.slice(0, MAX_THROWN_VALUE_LENGTH)}…`
    : text;
}

/**
 * Describe a thrown value.
 *
 * Non-Error throws keep whatever they carry — a bare string, a primitive or the
 * JSON of a plain object — because "Unknown error" is useless while debugging a
 * mock. Only `null`/`undefined` (which carry nothing) and values that cannot be
 * stringified safely fall back to "Unknown error"; a throwing `toString`, a
 * throwing getter or a circular reference must never turn the error path into a
 * second exception. Long stringifications are truncated so 500 bodies and debug
 * logs stay bounded.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === null || error === undefined) return "Unknown error";
  if (typeof error === "string") return truncateThrownValue(error);

  try {
    const text =
      typeof error === "object" ? JSON.stringify(error) : String(error);
    if (typeof text !== "string" || text.length === 0) return "Unknown error";
    return truncateThrownValue(text);
  } catch {
    return "Unknown error";
  }
}

/**
 * Base error class for all Schmock errors
 */
export class SchmockError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: unknown,
  ) {
    super(message);
    this.name = "SchmockError";
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when a route is not found
 */
export class RouteNotFoundError extends SchmockError {
  constructor(method: string, path: string) {
    super(`Route not found: ${method} ${path}`, "ROUTE_NOT_FOUND", {
      method,
      path,
    });
    this.name = "RouteNotFoundError";
  }
}

/**
 * Error thrown when route parsing fails
 */
export class RouteParseError extends SchmockError {
  constructor(routeKey: string, reason: string) {
    super(
      `Invalid route key format: "${routeKey}". ${reason}`,
      "ROUTE_PARSE_ERROR",
      { routeKey, reason },
    );
    this.name = "RouteParseError";
  }
}

/**
 * Error thrown when a response cannot be represented safely by transports
 */
export class InvalidResponseError extends SchmockError {
  constructor(reason: string, context: Record<string, unknown> = {}) {
    super(`Invalid response: ${reason}`, "INVALID_RESPONSE", {
      ...context,
      reason,
    });
    this.name = "InvalidResponseError";
  }
}

/**
 * Error thrown when a plugin fails
 */
export class PluginError extends SchmockError {
  constructor(pluginName: string, error: Error) {
    super(`Plugin "${pluginName}" failed: ${error.message}`, "PLUGIN_ERROR", {
      pluginName,
      originalError: error,
    });
    this.name = "PluginError";
  }
}

/**
 * Error thrown when route definition is invalid
 */
export class RouteDefinitionError extends SchmockError {
  constructor(routeKey: string, reason: string) {
    super(
      `Invalid route definition for "${routeKey}": ${reason}`,
      "ROUTE_DEFINITION_ERROR",
      { routeKey, reason },
    );
    this.name = "RouteDefinitionError";
  }
}

/**
 * Error thrown when schema validation fails
 */
export class SchemaValidationError extends SchmockError {
  constructor(schemaPath: string, issue: string, suggestion?: string) {
    super(
      `Schema validation failed at ${schemaPath}: ${issue}${suggestion ? `. ${suggestion}` : ""}`,
      "SCHEMA_VALIDATION_ERROR",
      { schemaPath, issue, suggestion },
    );
    this.name = "SchemaValidationError";
  }
}

/**
 * Error thrown when schema generation fails
 */
export class SchemaGenerationError extends SchmockError {
  constructor(route: string, error: Error, schema?: unknown) {
    super(
      `Schema generation failed for route ${route}: ${error.message}`,
      "SCHEMA_GENERATION_ERROR",
      { route, originalError: error, schema },
    );
    this.name = "SchemaGenerationError";
  }
}

/**
 * Error thrown when resource limits are exceeded
 */
export class ResourceLimitError extends SchmockError {
  constructor(resource: string, limit: number, actual?: number) {
    super(
      `Resource limit exceeded for ${resource}: limit=${limit}${actual ? `, actual=${actual}` : ""}`,
      "RESOURCE_LIMIT_ERROR",
      { resource, limit, actual },
    );
    this.name = "ResourceLimitError";
  }
}
