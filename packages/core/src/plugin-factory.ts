/**
 * Helper to create Schmock plugins with less boilerplate.
 *
 * @example
 * ```typescript
 * const myPlugin = createPlugin({
 *   name: 'my-plugin',
 *   process: (context, response) => {
 *     // transform response if it exists, or generate it if it doesn't
 *     return response ? { context, response: transform(response) } : { context, response: generate() };
 *   }
 * });
 * ```
 */
export function createPlugin(options: {
  name: string;
  version?: string;
  process: (
    context: Schmock.PluginContext,
    response?: any,
  ) => Schmock.PluginResult | Promise<Schmock.PluginResult>;
  onError?: (
    error: Error,
    context: Schmock.PluginContext,
  ) =>
    | Error
    | Schmock.ResponseResult
    | undefined
    | Promise<Error | Schmock.ResponseResult | undefined>;
}): Schmock.Plugin {
  return {
    name: options.name,
    version: options.version,
    process: options.process,
    onError: options.onError,
  };
}

/**
 * Helper to create a transformation-only plugin.
 * Automatically skips if there is no response yet.
 */
export function createTransformerPlugin(options: {
  name: string;
  version?: string;
  transform: (
    context: Schmock.PluginContext,
    response: any,
  ) => any | Promise<any>;
}): Schmock.Plugin {
  return {
    name: options.name,
    version: options.version,
    async process(context, response) {
      if (response === undefined || response === null) {
        return { context, response };
      }
      const transformed = await options.transform(context, response);
      return { context, response: transformed };
    },
  };
}

/**
 * Helper to create a generator-only plugin.
 * Automatically skips if a response already exists.
 */
export function createGeneratorPlugin(options: {
  name: string;
  version?: string;
  generate: (context: Schmock.PluginContext) => any | Promise<any>;
}): Schmock.Plugin {
  return {
    name: options.name,
    version: options.version,
    async process(context, response) {
      if (response !== undefined && response !== null) {
        return { context, response };
      }
      const generated = await options.generate(context);
      return { context, response: generated };
    },
  };
}
