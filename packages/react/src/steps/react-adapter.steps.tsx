/// <reference path="../../../core/schmock.d.ts" />

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useLayoutEffect, useState } from "react";
import { expect, vi } from "vitest";
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
});
