/// <reference path="../../core/schmock.d.ts" />

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
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

export function SchmockProvider({
  mock,
  options,
  children,
}: SchmockProviderProps) {
  // Intercept synchronously so child effects already see the patched fetch.
  // Re-intercept whenever the mock reference or options change (by value).
  const handleRef = useRef<Schmock.InterceptHandle | null>(null);
  const prevMockRef = useRef<Schmock.CallableMockInstance | null>(null);
  const prevOptionsRef = useRef<string | undefined>(undefined);

  const serializedOptions =
    options !== undefined ? JSON.stringify(options) : undefined;

  if (
    handleRef.current === null ||
    prevMockRef.current !== mock ||
    prevOptionsRef.current !== serializedOptions
  ) {
    handleRef.current?.restore();
    handleRef.current = mock.intercept(options);
    prevMockRef.current = mock;
    prevOptionsRef.current = serializedOptions;
  }

  useEffect(() => {
    return () => {
      handleRef.current?.restore();
      handleRef.current = null;
      prevMockRef.current = null;
      prevOptionsRef.current = undefined;
    };
  }, []);

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
