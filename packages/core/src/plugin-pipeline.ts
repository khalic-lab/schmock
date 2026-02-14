import { errorMessage, PluginError } from "./errors.js";

/** Structural typing — DebugLogger satisfies this without an import */
interface PipelineLogger {
  log(category: string, message: string, data?: unknown): void;
}

/**
 * Run all registered plugins in sequence
 * First plugin to set response becomes generator, subsequent plugins transform
 * Handles plugin errors via onError hooks
 */
export async function runPluginPipeline(
  plugins: Schmock.Plugin[],
  context: Schmock.PluginContext,
  initialResponse: unknown,
  logger: PipelineLogger,
): Promise<{ context: Schmock.PluginContext; response?: unknown }> {
  let currentContext = context;
  let response: unknown = initialResponse;

  logger.log(
    "pipeline",
    `Running plugin pipeline for ${plugins.length} plugins`,
  );

  for (const plugin of plugins) {
    logger.log("pipeline", `Processing plugin: ${plugin.name}`);

    try {
      const result = await plugin.process(currentContext, response);

      if (!result || !result.context) {
        throw new Error(`Plugin ${plugin.name} didn't return valid result`);
      }

      currentContext = result.context;

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
      logger.log(
        "pipeline",
        `Plugin ${plugin.name} failed: ${errorMessage(error)}`,
      );

      // Try error handling if plugin has onError hook
      if (plugin.onError) {
        try {
          const pluginError =
            error instanceof Error ? error : new Error(errorMessage(error));
          const errorResult = await plugin.onError(pluginError, currentContext);
          if (errorResult) {
            logger.log("pipeline", `Plugin ${plugin.name} handled error`);

            // Error return → transform the thrown error
            if (errorResult instanceof Error) {
              throw new PluginError(plugin.name, errorResult);
            }

            // ResponseResult return → recover, stop pipeline
            if (
              typeof errorResult === "object" &&
              errorResult !== null &&
              "status" in errorResult
            ) {
              response = errorResult;
              break;
            }
          }
          // void/falsy return → propagate original error below
        } catch (hookError) {
          // If the hook itself threw (including our PluginError above), re-throw it
          if (hookError instanceof PluginError) {
            throw hookError;
          }
          logger.log(
            "pipeline",
            `Plugin ${plugin.name} error handler failed: ${errorMessage(hookError)}`,
          );
        }
      }

      const cause =
        error instanceof Error ? error : new Error(errorMessage(error));
      throw new PluginError(plugin.name, cause);
    }
  }

  return { context: currentContext, response };
}
