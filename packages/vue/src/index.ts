import type * as Schmock from "@schmock/core";
import { type App, type InjectionKey, inject, type Plugin } from "vue";

// ===== Injection Key =====

const SCHMOCK_KEY: InjectionKey<Schmock.CallableMockInstance> =
  Symbol("schmock");

// ===== Plugin =====

export interface SchmockPluginOptions {
  mock: Schmock.CallableMockInstance;
  interceptOptions?: Schmock.InterceptOptions;
  /**
   * Alias of `interceptOptions`, under the name React's `SchmockProvider`
   * takes them. When both are given, `interceptOptions` is used.
   */
  options?: Schmock.InterceptOptions;
}

// Leases are keyed by app so they can be released without an unmount: an app
// that throws while mounting, or one that never mounts at all, still has to
// give `globalThis.fetch` back.
const interceptionLeases = new WeakMap<App, Schmock.InterceptHandle>();

/**
 * Release the interception lease an app acquired when `schmockPlugin` was
 * installed. Idempotent, and safe to call for an app that never intercepted
 * (a never-mounted app, a failed mount, or a server-rendered app).
 */
export function restoreSchmockInterception(app: App): void {
  const handle = interceptionLeases.get(app);
  if (!handle) return;

  interceptionLeases.delete(app);
  handle.restore();
}

export const schmockPlugin: Plugin<SchmockPluginOptions> = {
  install(app: App, pluginOptions: SchmockPluginOptions) {
    const { mock, interceptOptions = pluginOptions.options } = pluginOptions;

    app.provide(SCHMOCK_KEY, mock);

    // Without a DOM this is a server: `globalThis.fetch` is shared by every
    // concurrent request, so patching it would leak one render's mock into
    // another's. The mock is still provided, so `useSchmock()` keeps working.
    if (typeof document === "undefined") return;

    const handle = mock.intercept(interceptOptions);
    interceptionLeases.set(app, handle);

    const mountApp = app.mount.bind(app);
    app.mount = (...args: Parameters<App["mount"]>) => {
      let mounted: ReturnType<App["mount"]>;
      try {
        mounted = mountApp(...args);
      } catch (error) {
        // A failed mount never unmounts, so the unmount below never runs.
        restoreSchmockInterception(app);
        throw error;
      }
      // A selector that matches nothing makes Vue warn and return without
      // mounting. Vue sets _container only once a mount succeeds, so a repeat
      // mount of a mounted app, which also returns nothing, keeps its lease.
      if (!app._container) restoreSchmockInterception(app);
      return mounted;
    };

    // Released after the tree unmounts, not from app.onUnmount, which Vue
    // runs before it, so fetches from onBeforeUnmount and onUnmounted hooks
    // are still intercepted.
    const unmountApp = app.unmount.bind(app);
    app.unmount = () => {
      try {
        unmountApp();
      } finally {
        restoreSchmockInterception(app);
      }
    };
  },
};

// ===== Composable =====

export function useSchmock(): Schmock.CallableMockInstance {
  const mock = inject(SCHMOCK_KEY);
  if (!mock) {
    throw new Error(
      "useSchmock must be used in a component with schmockPlugin installed",
    );
  }
  return mock;
}
