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
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error thrown when a route is not found
 */
export class RouteNotFoundError extends SchmockError {
  constructor(method: string, path: string) {
    super(
      `Route not found: ${method} ${path}`,
      "ROUTE_NOT_FOUND",
      { method, path },
    );
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
 * Error thrown when response generation fails
 */
export class ResponseGenerationError extends SchmockError {
  constructor(route: string, error: Error) {
    super(
      `Failed to generate response for route ${route}: ${error.message}`,
      "RESPONSE_GENERATION_ERROR",
      { route, originalError: error },
    );
    this.name = "ResponseGenerationError";
  }
}

/**
 * Error thrown when a plugin fails
 */
export class PluginError extends SchmockError {
  constructor(pluginName: string, error: Error) {
    super(
      `Plugin "${pluginName}" failed: ${error.message}`,
      "PLUGIN_ERROR",
      { pluginName, originalError: error },
    );
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