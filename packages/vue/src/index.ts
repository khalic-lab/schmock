/// <reference path="../../core/schmock.d.ts" />

import {
  inject,
  type App,
  type InjectionKey,
  type Plugin,
} from "vue";

// ===== Injection Key =====

const SCHMOCK_KEY: InjectionKey<Schmock.CallableMockInstance> =
  Symbol("schmock");

// ===== Plugin =====

export interface SchmockPluginOptions {
  mock: Schmock.CallableMockInstance;
  interceptOptions?: Schmock.InterceptOptions;
}

export const schmockPlugin: Plugin<SchmockPluginOptions> = {
  install(app: App, options: SchmockPluginOptions) {
    const { mock, interceptOptions } = options;

    const handle = mock.intercept(interceptOptions);

    app.provide(SCHMOCK_KEY, mock);

    app.onUnmount(() => {
      handle.restore();
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
