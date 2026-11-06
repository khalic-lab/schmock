/** Longest stringification of a non-Error throw kept in a message. */
const MAX_THROWN_VALUE_LENGTH = 200;

function truncateThrownValue(text: string): string {
  return text.length > MAX_THROWN_VALUE_LENGTH
    ? `${text.slice(0, MAX_THROWN_VALUE_LENGTH)}…`
    : text;
}

function describeThrownValue(value: unknown): string {
  if (value === null || value === undefined) return "Unknown error";
  if (typeof value === "string") return truncateThrownValue(value);

  try {
    const text =
      typeof value === "object" ? JSON.stringify(value) : String(value);
    if (typeof text !== "string" || text.length === 0) return "Unknown error";
    return truncateThrownValue(text);
  } catch {
    return "Unknown error";
  }
}

/**
 * Whether a value is an Error from any realm. `instanceof Error` misses one
 * created in another realm (a `node:vm` context, an iframe), which would then
 * be described as the JSON of its enumerable fields: `"{}"`.
 */
export function isError(value: unknown): value is Error {
  if (value instanceof Error) return true;
  const isErrorOf: unknown = Reflect.get(Error, "isError");
  if (typeof isErrorOf === "function") {
    return Reflect.apply(isErrorOf, Error, [value]) === true;
  }
  return Object.prototype.toString.call(value) === "[object Error]";
}

/** An Error's `message` when it is a string; `undefined` otherwise, or when reading it throws. */
function stringMessageOf(error: Error): string | undefined {
  try {
    const message: unknown = error.message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Describe a thrown value. Total: always a string, never a throw.
 *
 * Non-Error throws keep whatever they carry — a bare string, a primitive or the
 * JSON of a plain object — because "Unknown error" is useless while debugging a
 * mock. Only `null`/`undefined` (which carry nothing) and values that cannot be
 * stringified safely fall back to "Unknown error"; a throwing `toString`, a
 * throwing getter or a circular reference must never turn the error path into a
 * second exception. Long stringifications are truncated so 500 bodies and debug
 * logs stay bounded. An Error whose `message` is not a string (a class that
 * redeclares the field, a message assigned later) has that message described
 * the same way.
 */
export function errorMessage(error: unknown): string {
  if (!isError(error)) return describeThrownValue(error);
  const message = stringMessageOf(error);
  if (message !== undefined) return message;
  try {
    return describeThrownValue(error.message);
  } catch {
    return "Unknown error";
  }
}

/**
 * The thrown value as an `Error` whose `message` is a string.
 *
 * An Error with a string message is returned as is, so its identity, class and
 * stack survive. Anything else, a non-Error throw or an Error whose message is
 * not a string, is wrapped in a new `Error` whose message is
 * {@link errorMessage}'s description and whose `cause` is the original value,
 * so an `errorFormatter` can still read what was thrown.
 */
export function toError(value: unknown): Error {
  if (isError(value) && stringMessageOf(value) !== undefined) {
    return value;
  }
  return new Error(errorMessage(value), { cause: value });
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
 * Error thrown by `toHttpMethod` for a string that is not one of the HTTP
 * methods Schmock routes (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`,
 * `OPTIONS`), compared case-insensitively.
 */
export class InvalidHttpMethodError extends SchmockError {
  constructor(method: string) {
    super(`Invalid HTTP method: "${method}"`, "INVALID_HTTP_METHOD", {
      method,
    });
    this.name = "InvalidHttpMethodError";
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
 *
 * @param path - Optional location of the breach (for example the schema path
 *   `$.properties.items`). When given it is appended to the message and added
 *   to the context; without it both keep their original shape.
 */
export class ResourceLimitError extends SchmockError {
  constructor(resource: string, limit: number, actual?: number, path?: string) {
    super(
      `Resource limit exceeded for ${resource}: limit=${limit}${actual ? `, actual=${actual}` : ""}${path === undefined ? "" : ` at ${path}`}`,
      "RESOURCE_LIMIT_ERROR",
      path === undefined
        ? { resource, limit, actual }
        : { resource, limit, actual, path },
    );
    this.name = "ResourceLimitError";
  }
}
