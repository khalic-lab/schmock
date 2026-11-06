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

interface InterceptionLease {
  mock: Schmock.CallableMockInstance;
  handle: Schmock.InterceptHandle;
  committed: boolean;
}

/**
 * The lease a commit owns, and one taken during a render not yet committed.
 * The provider owns the slots, so the installer that claims a lease and the
 * releaser that gives it back see the same ones.
 */
interface LeaseSlots {
  committed: InterceptionLease | null;
  pending: InterceptionLease | null;
}

interface InterceptionInstallerProps {
  mock: Schmock.CallableMockInstance;
  options?: Schmock.InterceptOptions;
  slots: LeaseSlots;
}

interface InterceptionReleaserProps {
  mock: Schmock.CallableMockInstance;
  slots: LeaseSlots;
}

/**
 * Take a lease while rendering, so a descendant that fetches during the same
 * render (Suspense data fetching, `use()` over a promise created in render)
 * is already intercepted. React may throw such a render away without ever
 * committing it (a suspended first mount, StrictMode's discarded double
 * render), and then no cleanup would run: the lease releases itself a task
 * later unless a commit has claimed it by then. Fetches issued in the
 * meantime were already dispatched through it. A task rather than a microtask,
 * so a render-created promise that awaits one mocked response and then fetches
 * again (a token, then the data) is still intercepted while a Suspense
 * boundary above the provider shows its fallback.
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
  setTimeout(() => {
    if (!lease.committed) lease.handle.restore();
  }, 0);
  return lease;
}

function InterceptionInstaller({
  mock,
  options,
  slots,
}: InterceptionInstallerProps) {
  const {
    baseUrl,
    passthrough,
    beforeRequest,
    beforeResponse,
    errorFormatter,
  } = options ?? {};

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
    slots.committed?.mock !== mock &&
    !(slots.pending?.mock === mock && slots.pending.handle.active)
  ) {
    slots.pending = acquireRenderLease(mock, {
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
  //
  // It is claimed in a commit (layout) effect, so a descendant's layout
  // effect is intercepted on the first mount, but released from a passive
  // effect's cleanup in InterceptionReleaser. A Suspense boundary that hides
  // content it already showed runs the layout cleanups of that content and
  // keeps its passive effects, so a layout cleanup would leave fetch unpatched
  // for as long as the fallback shows, and lose the provider its dispatch
  // position.
  useCommitEffect(() => {
    if (!hasDom()) return;

    // Still held: a reveal after such a hide runs this effect again.
    const committed = slots.committed;
    if (committed?.mock === mock && committed.handle.active) return;

    // Claim the render's lease; take a fresh one when there is none — after
    // StrictMode's simulated unmount, or once an uncommitted lease lapsed.
    const pending = slots.pending;
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
    slots.pending = null;
    slots.committed = lease;
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
    slots.committed?.handle.update(nextOptions);
  }, [baseUrl, passthrough, beforeRequest, beforeResponse, errorFormatter]);

  return null;
}

/**
 * Releases the lease the installer claimed. It renders after the provider's
 * children, and React runs a deleted tree's passive cleanups in tree order,
 * so a descendant's `useEffect` cleanup still fetches through the mock on
 * unmount.
 */
function InterceptionReleaser({ mock, slots }: InterceptionReleaserProps) {
  // A passive effect runs after every layout effect of the commit, so it sees
  // the lease the claim just took. A new mock's claim runs before this
  // cleanup for the old one, so the cleanup releases the lease it saw, plus
  // any later lease for the same mock, never the new mock's.
  useEffect(() => {
    const claimed = slots.committed;
    return () => {
      const current = slots.committed;
      if (current !== null && (current === claimed || current.mock === mock)) {
        slots.committed = null;
        current.handle.restore();
      }
      claimed?.handle.restore();
    };
  }, [mock, slots]);

  return null;
}

export function SchmockProvider({
  mock,
  options,
  children,
}: SchmockProviderProps) {
  const slots = useRef<LeaseSlots>({ committed: null, pending: null }).current;
  return createElement(
    SchmockContext.Provider,
    { value: mock },
    createElement(InterceptionInstaller, { mock, options, slots }),
    children,
    createElement(InterceptionReleaser, { mock, slots }),
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
