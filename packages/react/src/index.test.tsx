/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  Activity,
  StrictMode,
  startTransition,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchmockProvider, useSchmock } from "./index.js";
import { renderWithSchmock } from "./testing.js";

function UserList() {
  const [users, setUsers] = useState<Array<{ id: number; name: string }>>([]);

  useEffect(() => {
    void fetch("http://localhost/api/users")
      .then((res) => res.json())
      .then(setUsers);
  }, []);

  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}

/** Renders whether useSchmock() returned the expected instance. */
function MockConsumer({
  expected,
}: {
  expected?: Schmock.CallableMockInstance;
}) {
  const mock = useSchmock();
  return (
    <div data-testid="has-mock">{mock === expected ? "same" : "different"}</div>
  );
}

function LayoutEffectFetcher() {
  const [source, setSource] = useState("loading");

  useLayoutEffect(() => {
    let active = true;
    void fetch("http://localhost/api/layout-effect")
      .then((response) => response.json())
      .then((body: unknown) => {
        if (
          active &&
          typeof body === "object" &&
          body !== null &&
          "source" in body &&
          typeof body.source === "string"
        ) {
          setSource(body.source);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return <div data-testid="layout-effect-source">{source}</div>;
}

describe("SchmockProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("intercepts fetch and provides mocked data", async () => {
    const mock = schmock();
    mock("GET /api/users", [{ id: 1, name: "Alice" }]);

    render(
      <SchmockProvider mock={mock}>
        <UserList />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeDefined();
    });
  });

  it("restores fetch on unmount", () => {
    const mock = schmock();
    const savedFetch = globalThis.fetch;

    const { unmount } = render(
      <SchmockProvider mock={mock}>
        <div />
      </SchmockProvider>,
    );

    expect(globalThis.fetch).not.toBe(savedFetch);
    unmount();
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("intercepts descendant layout effects on the first commit", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ source: "real" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const mock = schmock();
    mock("GET /api/layout-effect", { source: "mock" });

    render(
      <SchmockProvider mock={mock}>
        <LayoutEffectFetcher />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("layout-effect-source").textContent).toBe(
        "mock",
      );
    });
  });

  it("survives StrictMode's setup-cleanup-setup lifecycle", async () => {
    const mock = schmock();
    mock("GET /api/users", [{ id: 1, name: "Strict Alice" }]);
    const savedFetch = globalThis.fetch;

    const { unmount } = render(
      <StrictMode>
        <SchmockProvider mock={mock}>
          <UserList />
        </SchmockProvider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByText("Strict Alice")).toBeDefined();
    });

    unmount();
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("composes nested providers and restores their handles together", async () => {
    const outerMock = schmock();
    outerMock("GET /api/outer", { source: "outer" });
    const innerMock = schmock();
    innerMock("GET /api/inner", { source: "inner" });
    const savedFetch = globalThis.fetch;

    const { unmount } = render(
      <SchmockProvider mock={outerMock}>
        <SchmockProvider mock={innerMock}>
          <div />
        </SchmockProvider>
      </SchmockProvider>,
    );

    const outerResponse = await fetch("http://localhost/api/outer");
    const innerResponse = await fetch("http://localhost/api/inner");
    expect(await outerResponse.json()).toEqual({ source: "outer" });
    expect(await innerResponse.json()).toEqual({ source: "inner" });

    unmount();
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("keeps a sibling provider active when an older sibling unmounts", async () => {
    const olderMock = schmock();
    olderMock("GET /api/older", { source: "older" });
    const newerMock = schmock();
    newerMock("GET /api/newer", { source: "newer" });
    const savedFetch = globalThis.fetch;

    const Providers = ({ showOlder }: { showOlder: boolean }) => (
      <>
        {showOlder ? (
          <SchmockProvider mock={olderMock}>
            <div />
          </SchmockProvider>
        ) : null}
        <SchmockProvider mock={newerMock}>
          <div />
        </SchmockProvider>
      </>
    );

    const { rerender, unmount } = render(<Providers showOlder />);
    rerender(<Providers showOlder={false} />);

    const response = await fetch("http://localhost/api/newer");
    expect(await response.json()).toEqual({ source: "newer" });

    unmount();
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("intercepts fetches from descendants' unmount cleanups", async () => {
    const mock = schmock();
    mock("POST /api/logout", () => ({ ok: true }));
    const realFetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("real"),
    );
    globalThis.fetch = realFetch;
    const sent: Array<Promise<string>> = [];
    const logout = (label: string) => {
      sent.push(
        fetch("http://localhost/api/logout", { method: "POST" })
          .then((response) => response.text())
          .then((body) => `${label}:${body}`),
      );
    };

    function Child() {
      useEffect(() => () => logout("effect"), []);
      useLayoutEffect(() => () => logout("layout"), []);
      return null;
    }

    const { unmount } = render(
      <SchmockProvider mock={mock}>
        <Child />
      </SchmockProvider>,
    );
    unmount();

    expect((await Promise.all(sent)).sort()).toEqual([
      'effect:{"ok":true}',
      'layout:{"ok":true}',
    ]);
    expect(realFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("releases the old mock's lease when the mock prop changes", async () => {
    const first = schmock();
    first("POST /api/logout", () => ({ who: "first" }));
    const second = schmock();
    second("POST /api/logout", () => ({ who: "second" }));
    const firstIntercept = vi.spyOn(first, "intercept");
    const secondIntercept = vi.spyOn(second, "intercept");
    const realFetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("real"),
    );
    globalThis.fetch = realFetch;
    const sent: Array<Promise<string>> = [];

    function Child() {
      useEffect(
        () => () => {
          sent.push(
            fetch("http://localhost/api/logout", { method: "POST" }).then(
              (response) => response.text(),
            ),
          );
        },
        [],
      );
      return null;
    }

    const { rerender, unmount } = render(
      <SchmockProvider mock={first}>
        <Child />
      </SchmockProvider>,
    );
    rerender(
      <SchmockProvider mock={second}>
        <Child />
      </SchmockProvider>,
    );

    // The switch gives the first mock's lease back once it commits.
    const handles = (spy: typeof firstIntercept) =>
      spy.mock.results.map(
        (result) => (result.value as Schmock.InterceptHandle).active,
      );
    expect(handles(firstIntercept)).not.toContain(true);
    expect(handles(secondIntercept)).toContain(true);

    unmount();

    expect(await Promise.all(sent)).toEqual(['{"who":"second"}']);
    expect(realFetch).not.toHaveBeenCalled();
    expect(handles(secondIntercept)).not.toContain(true);
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("intercepts render-time fetches when a hidden Activity is shown again", async () => {
    const mock = schmock();
    mock("GET /api/who", () => ({ who: "mock" }));
    const realFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ who: "network" }),
    );
    globalThis.fetch = realFetch;
    const sent: Array<Promise<unknown>> = [];

    // Fetches while rendering, as Suspense data fetching does.
    function RenderFetcher({ fetchNow }: { fetchNow: boolean }) {
      if (fetchNow) {
        sent.push(
          fetch("http://localhost/api/who").then((response) => response.json()),
        );
      }
      return null;
    }

    function App({ visible }: { visible: boolean }) {
      return (
        <Activity mode={visible ? "visible" : "hidden"}>
          <SchmockProvider mock={mock}>
            <RenderFetcher fetchNow={visible} />
          </SchmockProvider>
        </Activity>
      );
    }

    const { rerender } = render(<App visible={false} />);
    rerender(<App visible={true} />);
    sent.length = 0;

    // Hiding releases the lease; let any render-time lease lapse.
    rerender(<App visible={false} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(globalThis.fetch).toBe(realFetch);

    rerender(<App visible={true} />);

    expect(sent.length).toBeGreaterThan(0);
    for (const body of await Promise.all(sent)) {
      expect(body).toEqual({ who: "mock" });
    }
    expect(realFetch).not.toHaveBeenCalled();
  });

  it("restores fetch when provider rendering is abandoned", async () => {
    const mock = schmock();
    const savedFetch = globalThis.fetch;

    function BrokenChild(): never {
      throw new Error("render failed");
    }

    expect(() =>
      render(
        <SchmockProvider mock={mock}>
          <BrokenChild />
        </SchmockProvider>,
      ),
    ).toThrow("render failed");
    // The lease is taken while rendering, so render-phase fetches are
    // intercepted; a render that never commits releases it a task later.
    await new Promise((settle) => setTimeout(settle, 0));
    expect(globalThis.fetch).toBe(savedFetch);
  });

  describe("under an <Activity> boundary", () => {
    let realFetch: typeof globalThis.fetch;
    const manual: Schmock.InterceptHandle[] = [];

    beforeEach(() => {
      realFetch = vi.fn(async () => new Response("network"));
      globalThis.fetch = realFetch;
    });

    afterEach(() => {
      for (const handle of manual.splice(0)) handle.restore();
    });

    /** A lease taken outside the provider, released after the test if it is not. */
    const keep = (handle: Schmock.InterceptHandle) => {
      manual.push(handle);
      return handle;
    };

    const serving = (name: string, paths = ["/x"]) => {
      const mock = schmock();
      for (const path of paths) mock(`GET ${path}` as Schmock.RouteKey, name);
      return mock;
    };

    const text = async (path = "/x") =>
      (await fetch(`http://localhost${path}`)).text();

    const tick = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    const activeLeases = (spy: {
      mock: { results: Array<{ value: unknown }> };
    }) =>
      spy.mock.results.filter(
        (result) => (result.value as Schmock.InterceptHandle).active,
      ).length;

    function App({
      mode,
      mock,
    }: {
      mode: "visible" | "hidden";
      mock: Schmock.CallableMockInstance;
    }) {
      return (
        <Activity mode={mode}>
          <SchmockProvider mock={mock}>{null}</SchmockProvider>
        </Activity>
      );
    }

    it("keeps its place behind a lease taken after it mounted when a hidden Activity is shown again", async () => {
      const a = serving("A");
      const b = serving("B");
      const { rerender, unmount } = render(<App mode="visible" mock={a} />);
      const hb = keep(b.intercept());

      rerender(<App mode="hidden" mock={a} />);
      await tick();
      rerender(<App mode="visible" mock={a} />);

      expect(await text()).toBe("B");
      hb.restore();
      expect(await text()).toBe("A");
      unmount();
      expect(globalThis.fetch).toBe(realFetch);
    });

    it("does not outrank a newer lease while React renders the hidden Activity", async () => {
      const a = serving("A", ["/x", "/y"]);
      const b = serving("B");
      const { rerender } = render(<App mode="visible" mock={a} />);
      keep(b.intercept());

      // The offscreen render right after the hide takes a one-task lease.
      rerender(<App mode="hidden" mock={a} />);
      expect(await text("/x")).toBe("B");
      expect(await text("/y")).toBe("A");

      await tick();
      expect(await text("/y")).toBe("network");
    });

    it("stays behind a lease taken while it was hidden, after fetch was restored", async () => {
      const a = serving("A");
      const c = serving("C");
      const { rerender, unmount } = render(<App mode="visible" mock={a} />);

      rerender(<App mode="hidden" mock={a} />);
      await tick();
      expect(globalThis.fetch).toBe(realFetch);

      const hc = keep(c.intercept());
      rerender(<App mode="visible" mock={a} />);
      expect(await text()).toBe("C");
      hc.restore();
      expect(await text()).toBe("A");
      unmount();
      expect(globalThis.fetch).toBe(realFetch);
    });

    it("holds one lease at its place under StrictMode across an Activity hide and reveal", async () => {
      const a = serving("A");
      const b = serving("B");
      const spy = vi.spyOn(a, "intercept");
      const tree = (mode: "visible" | "hidden") => (
        <StrictMode>
          <App mode={mode} mock={a} />
        </StrictMode>
      );
      const { rerender, unmount } = render(tree("visible"));
      const hb = keep(b.intercept());

      await tick();
      expect(activeLeases(spy)).toBe(1);
      rerender(tree("hidden"));
      await tick();
      expect(activeLeases(spy)).toBe(0);
      rerender(tree("visible"));
      await tick();
      expect(activeLeases(spy)).toBe(1);

      expect(await text()).toBe("B");
      hb.restore();
      expect(await text()).toBe("A");
      unmount();
      expect(activeLeases(spy)).toBe(0);
    });

    it("keeps a lease older than the provider below it across a hide and reveal", async () => {
      const o = serving("O");
      const a = serving("A");
      keep(o.intercept());
      const { rerender } = render(<App mode="visible" mock={a} />);
      expect(await text()).toBe("A");

      rerender(<App mode="hidden" mock={a} />);
      await tick();
      expect(await text()).toBe("O");

      rerender(<App mode="visible" mock={a} />);
      expect(await text()).toBe("A");
    });

    it("gives a changed mock the front and keeps that place across a hide and reveal", async () => {
      const a = serving("A");
      const a2 = serving("A2");
      const b = serving("B");
      const { rerender } = render(<App mode="visible" mock={a} />);
      keep(b.intercept());

      rerender(<App mode="visible" mock={a2} />);
      expect(await text()).toBe("A2");

      const hd = keep(serving("D").intercept());
      rerender(<App mode="hidden" mock={a2} />);
      await tick();
      rerender(<App mode="visible" mock={a2} />);
      expect(await text()).toBe("D");
      hd.restore();
      expect(await text()).toBe("A2");
    });

    it("leaves no lease when unmounted while hidden", async () => {
      const a = serving("A");
      const spy = vi.spyOn(a, "intercept");
      const { rerender, unmount } = render(<App mode="visible" mock={a} />);

      rerender(<App mode="hidden" mock={a} />);
      unmount();
      await tick();

      expect(globalThis.fetch).toBe(realFetch);
      expect(spy.mock.results.length).toBeGreaterThan(0);
      expect(activeLeases(spy)).toBe(0);
    });

    it("lets the visible pane's provider answer when two Activity panes serve one route", async () => {
      const a = serving("A");
      const b = serving("B");
      function Panes({ tab }: { tab: "a" | "b" }) {
        return (
          <>
            <Activity mode={tab === "a" ? "visible" : "hidden"}>
              <SchmockProvider mock={a}>{null}</SchmockProvider>
            </Activity>
            <Activity mode={tab === "b" ? "visible" : "hidden"}>
              <SchmockProvider mock={b}>{null}</SchmockProvider>
            </Activity>
          </>
        );
      }
      const { rerender, unmount } = render(<Panes tab="a" />);
      await tick();
      expect(await text()).toBe("A");

      rerender(<Panes tab="b" />);
      await tick();
      expect(await text()).toBe("B");

      rerender(<Panes tab="a" />);
      await tick();
      expect(await text()).toBe("A");
      unmount();
      expect(globalThis.fetch).toBe(realFetch);
    });

    it("gives a mock changed while hidden the front on reveal and releases the old one", async () => {
      const a = serving("A");
      const b = serving("B");
      const c = serving("C");
      const spyA = vi.spyOn(a, "intercept");
      const { rerender, unmount } = render(<App mode="visible" mock={a} />);
      const hb = keep(b.intercept());

      rerender(<App mode="hidden" mock={a} />);
      rerender(<App mode="hidden" mock={c} />);
      await tick();
      expect(await text()).toBe("B");

      rerender(<App mode="visible" mock={c} />);
      expect(await text()).toBe("C");
      expect(activeLeases(spyA)).toBe(0);
      hb.restore();
      unmount();
      expect(globalThis.fetch).toBe(realFetch);
    });

    it("keeps a provider mounted hidden behind a lease taken after it mounted", async () => {
      const a = serving("A");
      const n = serving("N");
      const { rerender, unmount } = render(<App mode="hidden" mock={a} />);
      await tick();
      const hn = keep(n.intercept());

      rerender(<App mode="hidden" mock={a} />);
      expect(await text()).toBe("N");
      await tick();

      rerender(<App mode="visible" mock={a} />);
      expect(await text()).toBe("N");
      hn.restore();
      expect(await text()).toBe("A");
      unmount();
      expect(globalThis.fetch).toBe(realFetch);
    });

    it("keeps its place when a transition reveal commits after its render lease lapsed", async () => {
      const a = serving("A");
      const b = serving("B");
      const spy = vi.spyOn(a, "intercept");
      const href = "/reveal.css";
      const links = (rel: string) =>
        document.head.querySelectorAll(`link[rel="${rel}"][href="${href}"]`);

      type Step = "shown" | "hidden" | "revealed";
      let go!: (step: Step) => void;
      function Host() {
        const [step, setStep] = useState<Step>("shown");
        go = setStep;
        return (
          <Activity mode={step === "hidden" ? "hidden" : "visible"}>
            <SchmockProvider mock={a}>
              {step === "revealed" ? (
                <link rel="stylesheet" href={href} precedence="default" />
              ) : null}
            </SchmockProvider>
          </Activity>
        );
      }

      const { unmount } = render(<Host />);
      const hb = keep(b.intercept());

      act(() => go("hidden"));
      await tick();
      expect(activeLeases(spy)).toBe(0);

      // React holds a transition's commit until the stylesheets it adds have
      // loaded, but not inside act(), so the reveal is scheduled outside it.
      const actEnvironment = Reflect.get(
        globalThis,
        "IS_REACT_ACT_ENVIRONMENT",
      );
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
      try {
        const reveals = spy.mock.calls.length;
        startTransition(() => go("revealed"));
        await waitFor(() => {
          expect(links("preload")).toHaveLength(1);
        });
        // The reveal rendered and took its render lease, which lapses while
        // the commit waits for the stylesheet.
        expect(spy.mock.calls.length).toBe(reveals + 1);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(activeLeases(spy)).toBe(0);
        expect(links("stylesheet")).toHaveLength(0);
      } finally {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
      }

      const load = (rel: string) =>
        act(() => {
          for (const link of links(rel)) link.dispatchEvent(new Event("load"));
        });
      load("preload");
      load("stylesheet");
      expect(links("stylesheet")).toHaveLength(1);
      expect(activeLeases(spy)).toBe(1);

      expect(await text()).toBe("B");
      hb.restore();
      expect(await text()).toBe("A");
      unmount();
      expect(globalThis.fetch).toBe(realFetch);
      for (const link of [...links("preload"), ...links("stylesheet")]) {
        link.remove();
      }
    });

    it("keeps a provider mounted hidden behind a newer lease when its transition reveal commits after its render lease lapsed", async () => {
      const a = serving("A");
      const n = serving("N");
      const spy = vi.spyOn(a, "intercept");
      const href = "/reveal-mounted-hidden.css";
      const links = (rel: string) =>
        document.head.querySelectorAll(`link[rel="${rel}"][href="${href}"]`);

      let reveal!: () => void;
      function Host() {
        const [revealed, setRevealed] = useState(false);
        reveal = () => setRevealed(true);
        return (
          <Activity mode={revealed ? "visible" : "hidden"}>
            <SchmockProvider mock={a}>
              {revealed ? (
                <link rel="stylesheet" href={href} precedence="default" />
              ) : null}
            </SchmockProvider>
          </Activity>
        );
      }

      const { unmount } = render(<Host />);
      await tick();
      expect(activeLeases(spy)).toBe(0);
      const hn = keep(n.intercept());

      const actEnvironment = Reflect.get(
        globalThis,
        "IS_REACT_ACT_ENVIRONMENT",
      );
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
      try {
        const renders = spy.mock.calls.length;
        startTransition(() => reveal());
        await waitFor(() => {
          expect(links("preload")).toHaveLength(1);
        });
        expect(spy.mock.calls.length).toBe(renders + 1);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(activeLeases(spy)).toBe(0);
        expect(links("stylesheet")).toHaveLength(0);
      } finally {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
      }

      const load = (rel: string) =>
        act(() => {
          for (const link of links(rel)) link.dispatchEvent(new Event("load"));
        });
      load("preload");
      load("stylesheet");
      expect(links("stylesheet")).toHaveLength(1);
      expect(activeLeases(spy)).toBe(1);

      expect(await text()).toBe("N");
      hn.restore();
      expect(await text()).toBe("A");
      unmount();
      expect(globalThis.fetch).toBe(realFetch);
      for (const link of [...links("preload"), ...links("stylesheet")]) {
        link.remove();
      }
    });

    it("commits a changed mock at the place its render took when the commit waits past that render's lease", async () => {
      const a = serving("A");
      const b = serving("B");
      const c = serving("C");
      const d = serving("D");
      const spyA = vi.spyOn(a, "intercept");
      const spyC = vi.spyOn(c, "intercept");
      const href = "/changed-mock.css";
      const links = (rel: string) =>
        document.head.querySelectorAll(`link[rel="${rel}"][href="${href}"]`);

      let change!: () => void;
      function Host() {
        const [changed, setChanged] = useState(false);
        change = () => setChanged(true);
        return (
          <SchmockProvider mock={changed ? c : a}>
            {changed ? (
              <link rel="stylesheet" href={href} precedence="default" />
            ) : null}
          </SchmockProvider>
        );
      }

      const { unmount } = render(<Host />);
      expect(await text()).toBe("A");
      // Taken after the old mock committed and before the new mock rendered,
      // so the new mock goes ahead of it, not to the old mock's place behind.
      const hb = keep(b.intercept());

      const actEnvironment = Reflect.get(
        globalThis,
        "IS_REACT_ACT_ENVIRONMENT",
      );
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
      try {
        startTransition(() => change());
        await waitFor(() => {
          expect(links("preload")).toHaveLength(1);
        });
        // The new mock's render took one lease, which lapses while the commit
        // waits for the stylesheet; the old mock is still committed.
        expect(spyC.mock.calls.length).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(activeLeases(spyC)).toBe(0);
        expect(links("stylesheet")).toHaveLength(0);
      } finally {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
      }

      // Taken after the new mock rendered, so it stays ahead of the new mock,
      // which does not take the front when it commits.
      const hd = keep(d.intercept());
      const load = (rel: string) =>
        act(() => {
          for (const link of links(rel)) link.dispatchEvent(new Event("load"));
        });
      load("preload");
      load("stylesheet");
      expect(links("stylesheet")).toHaveLength(1);
      expect(activeLeases(spyC)).toBe(1);
      expect(activeLeases(spyA)).toBe(0);

      expect(await text()).toBe("D");
      hd.restore();
      expect(await text()).toBe("C");
      hb.restore();
      expect(await text()).toBe("C");
      unmount();
      expect(globalThis.fetch).toBe(realFetch);
      for (const link of [...links("preload"), ...links("stylesheet")]) {
        link.remove();
      }
    });
  });
});

describe("useSchmock", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("returns the mock instance from context", async () => {
    const mock = schmock();

    render(
      <SchmockProvider mock={mock}>
        <MockConsumer expected={mock} />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("has-mock").textContent).toBe("same");
    });
  });

  it("throws when used outside SchmockProvider", () => {
    expect(() => render(<MockConsumer />)).toThrow(/SchmockProvider/);
  });
});

describe("renderWithSchmock", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("sets up provider with routes and cleans up", async () => {
    const { unmount } = renderWithSchmock(<UserList />, {
      routes: [["GET /api/users", [{ id: 1, name: "Bob" }]]],
    });

    await waitFor(() => {
      expect(screen.getByText("Bob")).toBeDefined();
    });

    const fetchBeforeUnmount = globalThis.fetch;
    unmount();
    expect(globalThis.fetch).not.toBe(fetchBeforeUnmount);
  });

  it("shares one mock with an outer provider already intercepting", async () => {
    const mock = schmock();
    mock("GET /api/users", [{ id: 1, name: "Shared" }]);

    render(
      <SchmockProvider mock={mock}>
        <div />
      </SchmockProvider>,
    );

    expect(() => renderWithSchmock(<UserList />, { mock })).not.toThrow();

    await waitFor(() => {
      expect(screen.getByText("Shared")).toBeDefined();
    });
  });

  it("rerender preserves provider context", async () => {
    const mock = schmock();
    const { rerender } = renderWithSchmock(<MockConsumer expected={mock} />, {
      mock,
    });

    await waitFor(() => {
      expect(screen.getByTestId("has-mock").textContent).toBe("same");
    });

    // Rerender should still have the provider wrapping
    rerender(<MockConsumer expected={mock} />);

    await waitFor(() => {
      expect(screen.getByTestId("has-mock").textContent).toBe("same");
    });
  });
});
