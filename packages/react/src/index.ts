/// <reference path="../../core/schmock.d.ts" />

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useLayoutEffect,
} from "react";

// ===== Context =====

export const SchmockContext =
  createContext<Schmock.CallableMockInstance | null>(null);

// ===== Provider =====

export interface SchmockProviderProps {
  mock: Schmock.CallableMockInstance;
  options?: Schmock.InterceptOptions;
  children: ReactNode;
}

interface InterceptionInstallerProps {
  mock: Schmock.CallableMockInstance;
  options?: Schmock.InterceptOptions;
}

function InterceptionInstaller({ mock, options }: InterceptionInstallerProps) {
  const {
    baseUrl,
    passthrough,
    beforeRequest,
    beforeResponse,
    errorFormatter,
  } = options ?? {};

  useLayoutEffect(() => {
    const handle = mock.intercept({
      baseUrl,
      passthrough,
      beforeRequest,
      beforeResponse,
      errorFormatter,
    });

    return () => {
      handle.restore();
    };
  }, [
    mock,
    baseUrl,
    passthrough,
    beforeRequest,
    beforeResponse,
    errorFormatter,
  ]);

  return null;
}

export function SchmockProvider({
  mock,
  options,
  children,
}: SchmockProviderProps) {
  return createElement(
    SchmockContext.Provider,
    { value: mock },
    createElement(InterceptionInstaller, { mock, options }),
    children,
  );
}

// ===== Hook =====

export function useSchmock(): Schmock.CallableMockInstance {
  const mock = useContext(SchmockContext);
  if (mock === null) {
    throw new Error("useSchmock must be used within a SchmockProvider");
  }
  return mock;
}
