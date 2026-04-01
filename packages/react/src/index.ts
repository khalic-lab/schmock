/// <reference path="../../core/schmock.d.ts" />

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

// ===== Context =====

export const SchmockContext = createContext<Schmock.CallableMockInstance | null>(
  null,
);

// ===== Provider =====

export interface SchmockProviderProps {
  mock: Schmock.CallableMockInstance;
  options?: Schmock.InterceptOptions;
  children: ReactNode;
}

export function SchmockProvider({
  mock,
  options,
  children,
}: SchmockProviderProps) {
  // Intercept synchronously so child effects already see the patched fetch.
  const handleRef = useRef<Schmock.InterceptHandle | null>(null);
  if (handleRef.current === null) {
    handleRef.current = mock.intercept(options);
  }

  useEffect(() => {
    return () => {
      handleRef.current?.restore();
      handleRef.current = null;
    };
  }, [mock, options]);

  return createElement(SchmockContext.Provider, { value: mock }, children);
}

// ===== Hook =====

export function useSchmock(): Schmock.CallableMockInstance {
  const mock = useContext(SchmockContext);
  if (mock === null) {
    throw new Error("useSchmock must be used within a SchmockProvider");
  }
  return mock;
}
