/// <reference path="../../../core/schmock.d.ts" />

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useLayoutEffect, useState } from "react";
import { expect, type Mock, vi } from "vitest";
import { SchmockProvider, useSchmock } from "../index.js";

const feature = await loadFeature("../../features/react-adapter.feature");

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

function MockConsumer() {
  useSchmock();
  return <div data-testid="has-mock">yes</div>;
}

function NestedFetcher() {
  const [value, setValue] = useState("loading");

  useEffect(() => {
    void fetch("http://localhost/api/nested")
      .then((response) => response.json())
      .then((body: unknown) => {
        if (
          typeof body === "object" &&
          body !== null &&
          "value" in body &&
          typeof body.value === "string"
        ) {
          setValue(body.value);
        }
      });
  }, []);

  return <div data-testid="nested-value">{value}</div>;
}

function LayoutEffectFetcher() {
  const [value, setValue] = useState("loading");

  useLayoutEffect(() => {
    let active = true;
    void fetch("http://localhost/api/layout-effect")
      .then((response) => response.json())
      .then((body: unknown) => {
        if (
          active &&
          typeof body === "object" &&
          body !== null &&
          "value" in body &&
          typeof body.value === "string"
        ) {
          setValue(body.value);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return <div data-testid="layout-effect-value">{value}</div>;
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance;
  let originalFetch: typeof globalThis.fetch = globalThis.fetch;

  AfterEachScenario(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  Scenario(
    "SchmockProvider intercepts fetch calls",
    ({ Given, When, Then }) => {
      Given(
        'a Schmock instance with route "GET /api/users" returning users',
        () => {
          originalFetch = globalThis.fetch;
          mock = schmock();
          mock("GET /api/users", [{ id: 1, name: "Alice" }]);
        },
      );

      When(
        'I render a component that fetches "/api/users" inside SchmockProvider',
        () => {
          render(
            <SchmockProvider mock={mock}>
              <UserList />
            </SchmockProvider>,
          );
        },
      );

      Then("the component should display the mocked users", async () => {
        await waitFor(() => {
          expect(screen.getByText("Alice")).toBeDefined();
        });
        cleanup();
        globalThis.fetch = originalFetch;
      });
    },
  );

  Scenario(
    "SchmockProvider restores fetch on unmount",
    ({ Given, When, Then }) => {
      let savedFetch: typeof globalThis.fetch;

      Given(
        'a Schmock instance with route "GET /api/users" returning users',
        () => {
          originalFetch = globalThis.fetch;
          mock = schmock();
          mock("GET /api/users", [{ id: 1 }]);
        },
      );

      When("I mount and unmount a SchmockProvider", () => {
        savedFetch = globalThis.fetch;
        const { unmount } = render(
          <SchmockProvider mock={mock}>
            <div />
          </SchmockProvider>,
        );
        unmount();
      });

      Then("fetch should be restored to the original implementation", () => {
        expect(globalThis.fetch).toBe(savedFetch);
        cleanup();
        globalThis.fetch = originalFetch;
      });
    },
  );

  Scenario(
    "useSchmock throws outside SchmockProvider",
    ({ Given, When, Then }) => {
      let error: Error | undefined;

      Given("a component that calls useSchmock without a provider", () => {
        originalFetch = globalThis.fetch;
      });

      When("I try to render it", () => {
        try {
          render(<MockConsumer />);
        } catch (caught) {
          if (caught instanceof Error) error = caught;
        }
      });

      Then("it should throw an error mentioning SchmockProvider", () => {
        expect(error?.message).toMatch(/SchmockProvider/);
        cleanup();
        globalThis.fetch = originalFetch;
      });
    },
  );

  Scenario(
    "Provider applies a new request hook after rerender",
    ({ Given, When, Then }) => {
      let rerenderProvider: ((marker: string) => void) | undefined;

      Given('a provider request hook that marks requests as "first"', () => {
        originalFetch = globalThis.fetch;
        mock = schmock();
        mock("GET /api/hook", ({ headers }) => ({
          marker: headers["x-provider-hook"],
        }));

        const renderProvider = (marker: string) => (
          <SchmockProvider
            mock={mock}
            options={{
              beforeRequest: (request) => ({
                ...request,
                headers: {
                  ...request.headers,
                  "x-provider-hook": marker,
                },
              }),
            }}
          >
            <div />
          </SchmockProvider>
        );

        const result = render(renderProvider("first"));
        rerenderProvider = (marker) => result.rerender(renderProvider(marker));
      });

      When(
        'I rerender the provider with a hook that marks requests as "second"',
        () => {
          rerenderProvider?.("second");
        },
      );

      Then('subsequent requests should use the "second" hook', async () => {
        const response = await fetch("http://localhost/api/hook");
        expect(await response.json()).toEqual({ marker: "second" });
        cleanup();
        globalThis.fetch = originalFetch;
      });
    },
  );

  Scenario(
    "Descendant layout effects see interception on the first commit",
    ({ Given, When, Then }) => {
      Given(
        "a Schmock instance with a route for a layout-effect request",
        () => {
          originalFetch = globalThis.fetch;
          globalThis.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ value: "real backend" }), {
              headers: { "content-type": "application/json" },
            }),
          );
          mock = schmock();
          mock("GET /api/layout-effect", { value: "mocked layout effect" });
        },
      );

      When("I render a layout-effect fetcher inside SchmockProvider", () => {
        render(
          <SchmockProvider mock={mock}>
            <LayoutEffectFetcher />
          </SchmockProvider>,
        );
      });

      Then(
        "the layout-effect fetcher should display the mocked value",
        async () => {
          await waitFor(() => {
            expect(screen.getByTestId("layout-effect-value").textContent).toBe(
              "mocked layout effect",
            );
          });
        },
      );
    },
  );

  Scenario(
    "A mounted provider keeps interception across mock reset",
    ({ Given, When, Then }) => {
      let unmountProvider = () => {};
      let baselineFetch: Mock<typeof globalThis.fetch>;

      Given("a mounted provider with a first-generation route", () => {
        originalFetch = globalThis.fetch;
        baselineFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
          new Response(JSON.stringify({ generation: "real" }), {
            headers: { "content-type": "application/json" },
          }),
        );
        globalThis.fetch = baselineFetch;
        mock = schmock();
        mock("GET /api/generation", { generation: "first" });
        const rendered = render(
          <SchmockProvider mock={mock}>
            <div />
          </SchmockProvider>,
        );
        unmountProvider = rendered.unmount;
      });

      When("I reset and re-register the provider route", () => {
        mock.reset();
        mock("GET /api/generation", { generation: "second" });
      });

      Then(
        "the mounted provider should return the second generation",
        async () => {
          const response = await fetch("http://localhost/api/generation");
          expect(await response.json()).toEqual({ generation: "second" });
          expect(baselineFetch).not.toHaveBeenCalled();
          unmountProvider();
        },
      );
    },
  );

  Scenario(
    "Nested providers sharing one mock both install",
    ({ Given, When, Then, And }) => {
      let renderError: Error | undefined;

      Given("a Schmock instance with a route for nested providers", () => {
        originalFetch = globalThis.fetch;
        mock = schmock();
        mock("GET /api/nested", { value: "nested" });
      });

      When(
        "I render a provider for the same mock inside another provider",
        () => {
          try {
            render(
              <SchmockProvider mock={mock}>
                <SchmockProvider mock={mock}>
                  <NestedFetcher />
                </SchmockProvider>
              </SchmockProvider>,
            );
          } catch (caught) {
            renderError =
              caught instanceof Error ? caught : new Error(String(caught));
          }
        },
      );

      Then("the nested render should not throw", () => {
        expect(renderError).toBeUndefined();
      });

      And("the nested component should display the mocked value", async () => {
        await waitFor(() => {
          expect(screen.getByTestId("nested-value").textContent).toBe("nested");
        });
      });
    },
  );

  Scenario(
    "Changing provider options does not steal precedence from another root",
    ({ Given, When, Then }) => {
      let rerenderOlderRoot: ((marker: string) => void) | undefined;

      Given("two roots whose mocks both serve the same route", () => {
        originalFetch = globalThis.fetch;
        const olderMock = schmock();
        olderMock("GET /api/shared", ({ headers }) => ({
          source: "older",
          marker: headers["x-root"] ?? null,
        }));
        const newerMock = schmock();
        newerMock("GET /api/shared", { source: "newer" });

        const olderRoot = (marker: string) => (
          <SchmockProvider
            mock={olderMock}
            options={{
              beforeRequest: (request) => ({
                ...request,
                headers: { ...request.headers, "x-root": marker },
              }),
            }}
          >
            <div />
          </SchmockProvider>
        );

        const older = render(olderRoot("first"));
        render(
          <SchmockProvider mock={newerMock}>
            <div />
          </SchmockProvider>,
        );
        rerenderOlderRoot = (marker) => older.rerender(olderRoot(marker));
      });

      When("I rerender the older root with a new request hook", () => {
        rerenderOlderRoot?.("second");
      });

      Then("the newer root should still win the shared route", async () => {
        const response = await fetch("http://localhost/api/shared");
        expect(await response.json()).toEqual({ source: "newer" });
      });
    },
  );
});
