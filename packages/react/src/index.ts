import type * as Schmock from "@schmock/core";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

// Interception is a browser concern: without a DOM (server rendering) the
// provider installs nothing and only supplies the mock through context. The
// DOM is checked when the provider renders and commits, never at import time,
// so a test that registers jsdom or happy-dom after its hoisted imports still
// intercepts. The hook choice only avoids React 18's server warning for
// useLayoutEffect; both run the same DOM check inside.
function hasDom(): boolean {
  return typeof document !== "undefined";
}

const useCommitEffect: typeof useLayoutEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

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

interface InterceptionLease {
  mock: Schmock.CallableMockInstance;
  handle: Schmock.InterceptHandle;
  committed: boolean;
}

/**
 * Take a lease while rendering, so a descendant that fetches during the same
 * render (Suspense data fetching, `use()` over a promise created in render)
 * is already intercepted. React may throw such a render away without ever
 * committing it (a suspended first mount, StrictMode's discarded double
 * render), and then no cleanup would run: the lease releases itself at the
 * next microtask unless a commit has claimed it by then. Fetches issued in the
 * meantime were already dispatched through it.
 */
function acquireRenderLease(
  mock: Schmock.CallableMockInstance,
  options: Schmock.InterceptOptions,
): InterceptionLease {
  const lease: InterceptionLease = {
    mock,
    handle: mock.intercept(options),
    committed: false,
  };
  queueMicrotask(() => {
    if (!lease.committed) lease.handle.restore();
  });
  return lease;
}

function InterceptionInstaller({ mock, options }: InterceptionInstallerProps) {
  const {
    baseUrl,
    passthrough,
    beforeRequest,
    beforeResponse,
    errorFormatter,
  } = options ?? {};

  // The lease a commit owns, and one taken during a render not yet committed.
  const committedRef = useRef<InterceptionLease | null>(null);
  const pendingRef = useRef<InterceptionLease | null>(null);
  const optionsRef = useRef<Schmock.InterceptOptions>({
    baseUrl,
    passthrough,
    beforeRequest,
    beforeResponse,
    errorFormatter,
  });

  // Idempotent: a re-render, or StrictMode's second render call, finds the
  // lease it already holds for this mock and takes no other.
  if (
    hasDom() &&
    committedRef.current?.mock !== mock &&
    !(pendingRef.current?.mock === mock && pendingRef.current.handle.active)
  ) {
    pendingRef.current = acquireRenderLease(mock, {
      baseUrl,
      passthrough,
      beforeRequest,
      beforeResponse,
      errorFormatter,
    });
  }

  // The lease is keyed on the mock alone. A different mock is a genuinely new
  // owner and legitimately takes a new position in the interception stack;
  // option changes must not, or this provider would silently steal precedence
  // from another root that registered later.
  useCommitEffect(() => {
    if (!hasDom()) return;

    // Claim the render's lease; take a fresh one when there is none — after
    // StrictMode's simulated unmount, or once an uncommitted lease lapsed.
    const pending = pendingRef.current;
    let lease: InterceptionLease;
    if (pending?.mock === mock && pending.handle.active) {
      lease = pending;
      lease.committed = true;
    } else {
      lease = {
        mock,
        handle: mock.intercept(optionsRef.current),
        committed: true,
      };
    }
    pendingRef.current = null;
    committedRef.current = lease;

    return () => {
      if (committedRef.current === lease) committedRef.current = null;
      lease.handle.restore();
    };
  }, [mock]);

  // Declared after the lease effect so the handle exists on the first commit.
  useCommitEffect(() => {
    const nextOptions: Schmock.InterceptOptions = {
      baseUrl,
      passthrough,
      beforeRequest,
      beforeResponse,
      errorFormatter,
    };
    optionsRef.current = nextOptions;
    committedRef.current?.handle.update(nextOptions);
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
