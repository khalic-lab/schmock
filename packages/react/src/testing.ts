/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { render, type RenderResult } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { SchmockProvider } from "./index.js";

export interface RenderWithSchmockOptions {
  routes?: Array<[Schmock.RouteKey, Schmock.Generator, Schmock.RouteConfig?]>;
  interceptOptions?: Schmock.InterceptOptions;
  mock?: Schmock.CallableMockInstance;
}

export function renderWithSchmock(
  ui: ReactNode,
  options: RenderWithSchmockOptions = {},
): RenderResult & { mock: Schmock.CallableMockInstance } {
  const mock = options.mock ?? schmock();

  if (options.routes) {
    for (const [route, generator, config] of options.routes) {
      mock(route, generator, config);
    }
  }

  const result = render(
    createElement(SchmockProvider, {
      mock,
      options: options.interceptOptions,
      children: ui,
    }),
  );

  return {
    ...result,
    mock,
  };
}
