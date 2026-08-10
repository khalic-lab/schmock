import type * as Schmock from "@schmock/core";
import { type App, type InjectionKey, inject, type Plugin } from "vue";

// ===== Injection Key =====

const SCHMOCK_KEY: InjectionKey<Schmock.CallableMockInstance> =
  Symbol("schmock");

// ===== Plugin =====

export interface SchmockPluginOptions {
  mock: Schmock.CallableMockInstance;
  interceptOptions?: Schmock.InterceptOptions;
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
  install(app: App, options: SchmockPluginOptions) {
    const { mock, interceptOptions } = options;

    app.provide(SCHMOCK_KEY, mock);

    // Without a DOM this is a server: `globalThis.fetch` is shared by every
    // concurrent request, so patching it would leak one render's mock into
    // another's. The mock is still provided, so `useSchmock()` keeps working.
    if (typeof document === "undefined") return;

    const handle = mock.intercept(interceptOptions);
    interceptionLeases.set(app, handle);

    const mountApp = app.mount.bind(app);
    app.mount = (...args: Parameters<App["mount"]>) => {
      try {
        return mountApp(...args);
      } catch (error) {
        // A failed mount never unmounts, so onUnmount would never fire.
        restoreSchmockInterception(app);
        throw error;
      }
    };

    app.onUnmount(() => {
      restoreSchmockInterception(app);
    });
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
