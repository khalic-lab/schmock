import type { DebugLogger } from "./debug-logger.js";
import { errorMessage, SchmockError } from "./errors.js";

type PluginHook = "install" | "uninstall";

const PLUGIN_HOOK_ERROR_CODES = {
  install: {
    expired: "PLUGIN_INSTALL_SCOPE_EXPIRED",
    unsupported: "PLUGIN_INSTALL_OPERATION_UNSUPPORTED",
  },
  uninstall: {
    expired: "PLUGIN_UNINSTALL_SCOPE_EXPIRED",
    unsupported: "PLUGIN_UNINSTALL_OPERATION_UNSUPPORTED",
  },
} as const satisfies Record<
  PluginHook,
  { expired: string; unsupported: string }
>;

/**
 * Optional hooks that break the plugin when set to a truthy non-function:
 * `install` threw a TypeError from pipe() and `beforeRequest` failed every
 * matched request. Falsy values (`onError: null`, `install: false`) are how
 * callers switch a hook off and keep working; `onError`/`uninstall` failures
 * only ever surfaced on paths that already fail or log, so they are left alone.
 */
const EAGER_PLUGIN_HOOKS = ["install", "beforeRequest"] as const;

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function describeInvalidPlugin(plugin: unknown): string | undefined {
  if (
    (typeof plugin !== "object" && typeof plugin !== "function") ||
    plugin === null
  ) {
    return "expected a plugin object";
  }
  if (typeof Reflect.get(plugin, "process") !== "function") {
    return "process must be a function";
  }
  for (const hook of EAGER_PLUGIN_HOOKS) {
    const value: unknown = Reflect.get(plugin, hook);
    if (value && typeof value !== "function") {
      return `${hook} must be a function when set`;
    }
  }
  return undefined;
}

/**
 * Reject, when it is piped, a plugin that could never work: one without a
 * `process` function answered every matched request with a 500 instead.
 * Only shapes that already failed are rejected, so no working setup breaks.
 */
export function assertValidPlugin(
  plugin: unknown,
): asserts plugin is Schmock.Plugin {
  const reason = describeInvalidPlugin(plugin);
  if (reason === undefined) return;
  const name: unknown =
    typeof plugin === "object" && plugin !== null
      ? Reflect.get(plugin, "name")
      : undefined;
  const label = typeof name === "string" && name.length > 0 ? ` "${name}"` : "";
  throw new SchmockError(
    `Invalid plugin${label}: ${reason}`,
    "PLUGIN_INVALID",
    {
      plugin: typeof name === "string" ? name : undefined,
      reason,
    },
  );
}

/** The live reads a hook's instance forwards to the mock. */
export interface HookReadAccess {
  history(method?: Schmock.HttpMethod, path?: string): Schmock.RequestRecord[];
  called(method?: Schmock.HttpMethod, path?: string): boolean;
  callCount(method?: Schmock.HttpMethod, path?: string): number;
  lastRequest(
    method?: Schmock.HttpMethod,
    path?: string,
  ): Schmock.RequestRecord | undefined;
  getRoutes(): Schmock.RouteInfo[];
  getState(): Record<string, unknown>;
}

type RouteRegistrar = (
  route: Schmock.RouteKey,
  generator: Schmock.Generator,
  config: Schmock.RouteConfig,
) => void;

/**
 * The instance a plugin hook receives. Reads are live; route registration is
 * allowed only when the hook passes `registerRoute` (install does, uninstall
 * does not); every other operation is rejected. `isActive` expires the
 * facade when the hook returns, so a retained reference cannot act later.
 */
function createHookFacade(input: {
  plugin: Schmock.Plugin;
  hook: PluginHook;
  isActive: () => boolean;
  reads: HookReadAccess;
  registerRoute?: RouteRegistrar;
}): Schmock.CallableMockInstance {
  const { plugin, hook, isActive, reads, registerRoute } = input;
  const codes = PLUGIN_HOOK_ERROR_CODES[hook];
  const requireScope = () => {
    if (isActive()) return;
    throw new SchmockError(
      `Plugin "${plugin.name}" used its ${hook} instance outside ${hook}()`,
      codes.expired,
      { plugin: plugin.name },
    );
  };
  const reject = (operation: string): never => {
    requireScope();
    throw new SchmockError(
      `Plugin "${plugin.name}" cannot call ${operation} during ${hook}()`,
      codes.unsupported,
      { operation, plugin: plugin.name },
    );
  };
  let facade: Schmock.CallableMockInstance;
  const defineRoute = (
    route: Schmock.RouteKey,
    generator: Schmock.Generator,
    config: Schmock.RouteConfig = {},
  ): Schmock.CallableMockInstance => {
    if (!registerRoute) return reject("route registration");
    requireScope();
    registerRoute(route, generator, config);
    return facade;
  };
  facade = Object.assign(defineRoute, {
    pipe: () => reject("pipe()"),
    handle: () => reject("handle()"),
    history: (method?: Schmock.HttpMethod, path?: string) => {
      requireScope();
      return reads.history(method, path);
    },
    called: (method?: Schmock.HttpMethod, path?: string) => {
      requireScope();
      return reads.called(method, path);
    },
    callCount: (method?: Schmock.HttpMethod, path?: string) => {
      requireScope();
      return reads.callCount(method, path);
    },
    lastRequest: (method?: Schmock.HttpMethod, path?: string) => {
      requireScope();
      return reads.lastRequest(method, path);
    },
    reset: () => reject("reset()"),
    resetHistory: () => reject("resetHistory()"),
    resetState: () => reject("resetState()"),
    on: () => reject("on()"),
    off: () => reject("off()"),
    getRoutes: () => {
      requireScope();
      return reads.getRoutes();
    },
    getState: () => {
      requireScope();
      return reads.getState();
    },
    listen: () => reject("listen()"),
    close: () => reject("close()"),
    intercept: () => reject("intercept()"),
  });
  return facade;
}

/**
 * Run a plugin's `install()` against an expiring facade that may register
 * routes. A Promise returned from `install()` is rejected: the routes it would
 * register later could not be rolled back. The caller owns the rollback of
 * whatever the hook registered before it threw.
 */
export function runInstallHook(input: {
  plugin: Schmock.Plugin;
  reads: HookReadAccess;
  registerRoute: RouteRegistrar;
  logger: DebugLogger;
}): void {
  const { plugin, logger } = input;
  if (!plugin.install) return;

  let installActive = true;
  const installFacade = createHookFacade({
    plugin,
    hook: "install",
    isActive: () => installActive,
    reads: input.reads,
    registerRoute: input.registerRoute,
  });

  try {
    const installResult: unknown = plugin.install(installFacade);
    installActive = false;
    if (isThenable(installResult)) {
      void Promise.resolve(installResult).catch((error) => {
        logger.log(
          "plugin",
          `Rejected async install for ${plugin.name}: ${errorMessage(error)}`,
        );
      });
      throw new SchmockError(
        `Plugin "${plugin.name}" returned a Promise from install()`,
        "PLUGIN_ASYNC_INSTALL_UNSUPPORTED",
        { plugin: plugin.name },
      );
    }
  } finally {
    installActive = false;
  }
}

/**
 * Run `uninstall()` for each plugin, last piped first. A failing hook is
 * logged and never stops the others.
 */
export function runUninstallHooks(input: {
  plugins: readonly Schmock.Plugin[];
  reads: HookReadAccess;
  logger: DebugLogger;
}): void {
  const { plugins, logger } = input;
  for (let index = plugins.length - 1; index >= 0; index -= 1) {
    const plugin = plugins[index];
    if (!plugin.uninstall) continue;

    // Cleanup gets a read-only, expiring instance: through the live one a
    // plugin could pipe plugins or register routes into the mock that
    // reset() just cleared.
    let uninstallActive = true;
    const uninstallFacade = createHookFacade({
      plugin,
      hook: "uninstall",
      isActive: () => uninstallActive,
      reads: input.reads,
    });
    try {
      const uninstallResult: unknown = plugin.uninstall(uninstallFacade);
      if (isThenable(uninstallResult)) {
        void Promise.resolve(uninstallResult).catch((error) => {
          logger.log(
            "plugin",
            `Async uninstall for ${plugin.name} failed: ${errorMessage(error)}`,
          );
        });
        logger.log(
          "plugin",
          `Plugin ${plugin.name} returned an unsupported Promise from uninstall()`,
        );
      }
    } catch (error) {
      logger.log(
        "plugin",
        `Plugin ${plugin.name} uninstall failed: ${errorMessage(error)}`,
      );
    } finally {
      uninstallActive = false;
    }
  }
}
