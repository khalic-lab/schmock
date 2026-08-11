import { awaitWithAbort, throwIfAborted } from "./abort.js";
import { errorMessage, PluginError } from "./errors.js";

/** Structural typing — DebugLogger satisfies this without an import */
interface PipelineLogger {
  log(category: string, message: string, data?: unknown): void;
}

interface PipelineResult {
  context: Schmock.PluginContext;
  response?: unknown;
  recoveredFromError?: boolean;
  requestShortCircuited?: boolean;
}

function isPluginResult(value: unknown): value is Schmock.PluginResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "context" in value &&
    typeof value.context === "object" &&
    value.context !== null
  );
}

function preserveRequestSignal(
  context: Schmock.PluginContext,
  signal: AbortSignal | undefined,
): Schmock.PluginContext {
  return context.signal === signal ? context : { ...context, signal };
}

async function recoverPluginError(
  plugins: readonly Schmock.Plugin[],
  startIndex: number,
  error: unknown,
  context: Schmock.PluginContext,
  logger: PipelineLogger,
  signal?: AbortSignal,
): Promise<
  { handled: true; response: unknown } | { handled: false; error: Error }
> {
  let currentError =
    error instanceof Error ? error : new Error(errorMessage(error));

  for (let index = startIndex; index < plugins.length; index += 1) {
    throwIfAborted(signal);
    const plugin = plugins[index];
    if (!plugin.onError) continue;

    try {
      const errorResult = await awaitWithAbort(
        plugin.onError(currentError, context),
        signal,
      );
      throwIfAborted(signal);
      if (errorResult instanceof Error) {
        currentError = errorResult;
        continue;
      }
      if (errorResult !== undefined) {
        logger.log("pipeline", `Plugin ${plugin.name} handled error`);
        return { handled: true, response: errorResult };
      }
    } catch (hookError) {
      throwIfAborted(signal);
      currentError =
        hookError instanceof Error
          ? hookError
          : new Error(errorMessage(hookError));
      logger.log(
        "pipeline",
        `Plugin ${plugin.name} error handler failed: ${errorMessage(hookError)}`,
      );
    }
  }

  return { handled: false, error: currentError };
}

/** Run request guards before route code is allowed to execute. */
export async function runPluginBeforeRequest(
  plugins: readonly Schmock.Plugin[],
  context: Schmock.PluginContext,
  logger: PipelineLogger,
  signal = context.signal,
): Promise<PipelineResult> {
  let currentContext = preserveRequestSignal(context, signal);

  for (let index = 0; index < plugins.length; index += 1) {
    throwIfAborted(signal);
    const plugin = plugins[index];
    if (!plugin.beforeRequest) continue;

    logger.log("pipeline", `Running beforeRequest: ${plugin.name}`);
    try {
      const result = await awaitWithAbort(
        plugin.beforeRequest(currentContext),
        signal,
      );
      throwIfAborted(signal);
      if (result === undefined) continue;
      if (!isPluginResult(result)) {
        throw new Error(`Plugin ${plugin.name} didn't return valid result`);
      }

      currentContext = preserveRequestSignal(result.context, signal);
      if (result.response !== undefined) {
        logger.log("pipeline", `Plugin ${plugin.name} rejected request`);
        return {
          context: currentContext,
          response: result.response,
          requestShortCircuited: true,
        };
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.log(
        "pipeline",
        `Plugin ${plugin.name} beforeRequest failed: ${errorMessage(error)}`,
      );
      const recovery = await recoverPluginError(
        plugins,
        index,
        error,
        currentContext,
        logger,
        signal,
      );
      if (recovery.handled) {
        return {
          context: currentContext,
          response: recovery.response,
          recoveredFromError: true,
          requestShortCircuited: true,
        };
      }
      throw new PluginError(plugin.name, recovery.error);
    }
  }

  return { context: currentContext };
}

/** Give pipeline error handlers a chance to recover a route-generator error. */
export async function recoverGeneratorError(
  plugins: readonly Schmock.Plugin[],
  context: Schmock.PluginContext,
  error: unknown,
  logger: PipelineLogger,
  signal = context.signal,
): Promise<PipelineResult> {
  throwIfAborted(signal);
  const recovery = await recoverPluginError(
    plugins,
    0,
    error,
    context,
    logger,
    signal,
  );
  throwIfAborted(signal);
  if (recovery.handled) {
    return {
      context,
      response: recovery.response,
      recoveredFromError: true,
    };
  }
  throw recovery.error;
}

/**
 * Run all registered plugins in sequence
 * First plugin to set response becomes generator, subsequent plugins transform
 * Handles plugin errors via onError hooks
 */
export async function runPluginPipeline(
  plugins: readonly Schmock.Plugin[],
  context: Schmock.PluginContext,
  initialResponse: unknown,
  logger: PipelineLogger,
  signal = context.signal,
): Promise<PipelineResult> {
  let currentContext = preserveRequestSignal(context, signal);
  let response: unknown = initialResponse;

  logger.log(
    "pipeline",
    `Running plugin pipeline for ${plugins.length} plugins`,
  );

  for (let index = 0; index < plugins.length; index += 1) {
    throwIfAborted(signal);
    const plugin = plugins[index];
    logger.log("pipeline", `Processing plugin: ${plugin.name}`);

    try {
      const result = await awaitWithAbort(
        plugin.process(currentContext, response),
        signal,
      );
      throwIfAborted(signal);

      if (!isPluginResult(result)) {
        throw new Error(`Plugin ${plugin.name} didn't return valid result`);
      }

      currentContext = preserveRequestSignal(result.context, signal);

      // First plugin to set response becomes the generator
      if (
        result.response !== undefined &&
        (response === undefined || response === null)
      ) {
        logger.log("pipeline", `Plugin ${plugin.name} generated response`);
        response = result.response;
      } else if (result.response !== undefined && response !== undefined) {
        logger.log("pipeline", `Plugin ${plugin.name} transformed response`);
        response = result.response;
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.log(
        "pipeline",
        `Plugin ${plugin.name} failed: ${errorMessage(error)}`,
      );

      const recovery = await recoverPluginError(
        plugins,
        index,
        error,
        currentContext,
        logger,
        signal,
      );
      if (recovery.handled) {
        return {
          context: currentContext,
          response: recovery.response,
          recoveredFromError: true,
        };
      }
      throw new PluginError(plugin.name, recovery.error);
    }
  }

  return { context: currentContext, response };
}
