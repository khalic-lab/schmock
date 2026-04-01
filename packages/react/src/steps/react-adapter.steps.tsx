/// <reference path="../../../core/schmock.d.ts" />

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import React, { useEffect, useState } from "react";
import { schmock } from "@schmock/core";
import { SchmockProvider, useSchmock } from "../index.js";
import { renderWithSchmock } from "../testing.js";

const feature = await loadFeature("../../features/react-adapter.feature");

function UserList() {
  const [users, setUsers] = useState<Array<{ id: number; name: string }>>([]);

  useEffect(() => {
    fetch("http://localhost/api/users")
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
  const mock = useSchmock();
  return <div data-testid="has-mock">{mock ? "yes" : "no"}</div>;
}

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let originalFetch: typeof globalThis.fetch;

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

      Then(
        "fetch should be restored to the original implementation",
        () => {
          expect(globalThis.fetch).toBe(savedFetch);
          cleanup();
          globalThis.fetch = originalFetch;
        },
      );
    },
  );

  Scenario(
    "useSchmock returns the mock instance",
    ({ Given, When, Then }) => {
      Given("a Schmock instance", () => {
        originalFetch = globalThis.fetch;
        mock = schmock();
      });

      When(
        "I render a component that calls useSchmock inside SchmockProvider",
        () => {
          render(
            <SchmockProvider mock={mock}>
              <MockConsumer />
            </SchmockProvider>,
          );
        },
      );

      Then("it should receive the CallableMockInstance", async () => {
        await waitFor(() => {
          expect(screen.getByTestId("has-mock").textContent).toBe("yes");
        });
        cleanup();
        globalThis.fetch = originalFetch;
      });
    },
  );

  Scenario(
    "Passthrough for unmatched routes",
    ({ Given, When, Then, And }) => {
      const fakeFetch = vi.fn().mockResolvedValue(new Response("real"));

      Given(
        'a Schmock instance with route "GET /api/users" returning users',
        () => {
          originalFetch = globalThis.fetch;
          globalThis.fetch = fakeFetch;
          mock = schmock();
          mock("GET /api/users", [{ id: 1 }]);
        },
      );

      And("the provider is configured with passthrough enabled", () => {
        render(
          <SchmockProvider mock={mock} options={{ passthrough: true }}>
            <div />
          </SchmockProvider>,
        );
      });

      When('the component fetches "/api/other"', async () => {
        await fetch("http://localhost/api/other");
      });

      Then(
        "the request should pass through to the original fetch",
        () => {
          expect(fakeFetch).toHaveBeenCalled();
          cleanup();
          globalThis.fetch = originalFetch;
        },
      );
    },
  );

  Scenario(
    "renderWithSchmock test utility handles setup and cleanup",
    ({ Given, When, Then }) => {
      Given(
        'route definitions for "GET /api/users" returning users',
        () => {
          originalFetch = globalThis.fetch;
          // Routes defined inline in renderWithSchmock
        },
      );

      When(
        'I use renderWithSchmock to render a component that fetches "/api/users"',
        () => {
          renderWithSchmock(<UserList />, {
            routes: [["GET /api/users", [{ id: 1, name: "Bob" }]]],
          });
        },
      );

      Then("the component should display the mocked users", async () => {
        await waitFor(() => {
          expect(screen.getByText("Bob")).toBeDefined();
        });
        cleanup();
        globalThis.fetch = originalFetch;
      });
    },
  );
});
