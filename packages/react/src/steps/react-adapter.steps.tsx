/// <reference path="../../../core/schmock.d.ts" />

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import React, { useEffect, useState } from "react";
import { schmock, notFound } from "@schmock/core";
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

function ErrorFetcher() {
  const [status, setStatus] = useState<number | null>(null);

  useEffect(() => {
    fetch("http://localhost/api/missing").then((res) => {
      setStatus(res.status);
    });
  }, []);

  return <div data-testid="status">{status ?? "loading"}</div>;
}

function PostForm() {
  const [result, setResult] = useState<string>("");

  useEffect(() => {
    fetch("http://localhost/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Widget" }),
    })
      .then((res) => res.json())
      .then((data) => setResult(data.name));
  }, []);

  return <div data-testid="result">{result || "loading"}</div>;
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

  Scenario(
    "Error status codes flow through correctly",
    ({ Given, When, Then }) => {
      Given("a Schmock instance with a route returning status 404", () => {
        originalFetch = globalThis.fetch;
        mock = schmock();
        mock("GET /api/missing", notFound("Not here"));
      });

      When(
        "I render a component that fetches that route inside SchmockProvider",
        () => {
          render(
            <SchmockProvider mock={mock}>
              <ErrorFetcher />
            </SchmockProvider>,
          );
        },
      );

      Then("the component should receive the error status", async () => {
        await waitFor(() => {
          expect(screen.getByTestId("status").textContent).toBe("404");
        });
        cleanup();
        globalThis.fetch = originalFetch;
      });
    },
  );

  Scenario(
    "POST with JSON body works through the provider",
    ({ Given, When, Then }) => {
      Given(
        "a Schmock instance with a POST route that echoes the body",
        () => {
          originalFetch = globalThis.fetch;
          mock = schmock();
          mock("POST /api/items", ({ body }) => [201, body]);
        },
      );

      When(
        "I render a component that posts data inside SchmockProvider",
        () => {
          render(
            <SchmockProvider mock={mock}>
              <PostForm />
            </SchmockProvider>,
          );
        },
      );

      Then("the component should display the echoed data", async () => {
        await waitFor(() => {
          expect(screen.getByTestId("result").textContent).toBe("Widget");
        });
        cleanup();
        globalThis.fetch = originalFetch;
      });
    },
  );

  Scenario(
    "useSchmock throws outside SchmockProvider",
    ({ Given, When, Then }) => {
      let error: Error | undefined;

      Given(
        "a component that calls useSchmock without a provider",
        () => {
          originalFetch = globalThis.fetch;
        },
      );

      When("I try to render it", () => {
        try {
          render(<MockConsumer />);
        } catch (e) {
          error = e as Error;
        }
      });

      Then(
        "it should throw an error mentioning SchmockProvider",
        () => {
          expect(error?.message).toMatch(/SchmockProvider/);
          cleanup();
          globalThis.fetch = originalFetch;
        },
      );
    },
  );
});
