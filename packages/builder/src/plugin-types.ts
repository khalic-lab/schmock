/// <reference path="../../../types/schmock.d.ts" />

/**
 * Internal plugin context with typed route
 */
export interface InternalPluginContext
  extends Omit<Schmock.PluginContext, "route"> {
  route: {
    schema?: unknown;
    response?: Schmock.ResponseFunction;
    count?: number;
    overrides?: Record<string, unknown>;
  };
}

/**
 * Plugin with proper typing
 */
export interface TypedPlugin extends Schmock.Plugin {
  generate?(
    context: InternalPluginContext,
  ): unknown | undefined | Promise<unknown | undefined>;
  transform?(
    data: unknown,
    context: InternalPluginContext,
  ): unknown | Promise<unknown>;
  beforeResponse?(
    data: unknown,
    context: InternalPluginContext,
  ): void | Promise<void>;
}

/**
 * Type guard to check if a value is a SchmockError
 */
export function isSchmockError(
  error: unknown,
): error is import("./errors").SchmockError {
  return error instanceof Error && "code" in error;
}

/**
 * Type guard to check if a response is a tuple
 */
export function isResponseTuple(
  value: unknown,
): value is [number, unknown] | [number, unknown, Record<string, string>] {
  return (
    Array.isArray(value) && value.length >= 2 && typeof value[0] === "number"
  );
}
