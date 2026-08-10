import type * as Schmock from "@schmock/core";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";

// Layout effects never run while rendering on the server, and calling
// useLayoutEffect there only produces a warning. Interception is a browser
// concern, so the installer is a no-op without a DOM.
const useInterceptionEffect: typeof useLayoutEffect =
  typeof document === "undefined" ? () => {} : useLayoutEffect;

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

  const handleRef = useRef<Schmock.InterceptHandle | null>(null);
  const optionsRef = useRef<Schmock.InterceptOptions>({
    baseUrl,
    passthrough,
    beforeRequest,
    beforeResponse,
    errorFormatter,
  });

  // The lease is keyed on the mock alone. A different mock is a genuinely new
  // owner and legitimately takes a new position in the interception stack;
  // option changes must not, or this provider would silently steal precedence
  // from another root that registered later.
  useInterceptionEffect(() => {
    const handle = mock.intercept(optionsRef.current);
    handleRef.current = handle;

    return () => {
      handleRef.current = null;
      handle.restore();
    };
  }, [mock]);

  // Declared after the lease effect so the handle exists on the first commit.
  useInterceptionEffect(() => {
    const nextOptions: Schmock.InterceptOptions = {
      baseUrl,
      passthrough,
      beforeRequest,
      beforeResponse,
      errorFormatter,
    };
    optionsRef.current = nextOptions;
    handleRef.current?.update(nextOptions);
  }, [baseUrl, passthrough, beforeRequest, beforeResponse, errorFormatter]);

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
