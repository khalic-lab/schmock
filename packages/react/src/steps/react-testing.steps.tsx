/// <reference path="../../../core/schmock.d.ts" />

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { cleanup, screen } from "@testing-library/react";
import { expect, vi } from "vitest";
import { useSchmock } from "../index.js";
import { renderWithSchmock } from "../testing.js";

const feature = await loadFeature("../../features/react-testing.feature");

function ContextConsumer({
  expected,
  label = "consumer",
}: {
  expected: Schmock.CallableMockInstance;
  label?: string;
}) {
  const actual = useSchmock();
  return (
    <div data-testid="context-consumer">
      {label}:{actual === expected ? "same" : "different"}
    </div>
  );
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance;
  let result: ReturnType<typeof renderWithSchmock>;
  let originalFetch: typeof globalThis.fetch = globalThis.fetch;
  let interceptedFetch: typeof globalThis.fetch;

  AfterEachScenario(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  Scenario(
    "renderWithSchmock supplies the mock through context",
    ({ Given, When, Then }) => {
      Given("a mock for the React testing utility", () => {
        originalFetch = globalThis.fetch;
        mock = schmock();
      });

      When("I render a context consumer with renderWithSchmock", () => {
        result = renderWithSchmock(<ContextConsumer expected={mock} />, {
          mock,
        });
      });

      Then("the consumer should receive the same mock instance", () => {
        expect(screen.getByTestId("context-consumer").textContent).toBe(
          "consumer:same",
        );
        expect(result.mock).toBe(mock);
      });
    },
  );

  Scenario(
    "Rerender preserves the provider context",
    ({ Given, When, Then }) => {
      Given("a rendered context consumer from renderWithSchmock", () => {
        originalFetch = globalThis.fetch;
        mock = schmock();
        result = renderWithSchmock(
          <ContextConsumer expected={mock} label="first" />,
          { mock },
        );
      });

      When("I rerender the consumer with different content", () => {
        result.rerender(<ContextConsumer expected={mock} label="second" />);
      });

      Then(
        "the rerendered consumer should retain the same mock instance",
        () => {
          expect(screen.getByTestId("context-consumer").textContent).toBe(
            "second:same",
          );
        },
      );
    },
  );

  Scenario("Unmount restores fetch interception", ({ Given, When, Then }) => {
    Given("a mounted renderWithSchmock result", () => {
      originalFetch = vi.fn().mockResolvedValue(new Response("backend"));
      globalThis.fetch = originalFetch;
      mock = schmock();
      result = renderWithSchmock(<ContextConsumer expected={mock} />, {
        mock,
      });
      interceptedFetch = globalThis.fetch;
      expect(interceptedFetch).not.toBe(originalFetch);
    });

    When("I unmount the testing result", () => {
      result.unmount();
    });

    Then("the original fetch implementation should be restored", () => {
      expect(globalThis.fetch).toBe(originalFetch);
    });
  });
});
