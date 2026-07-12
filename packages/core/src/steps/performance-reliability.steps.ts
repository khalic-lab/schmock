import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";

const feature = await loadFeature(
  "../../features/performance-reliability.feature",
);

function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let releaseBarrier: (() => void) | undefined;
  let boundedBarrier: Promise<void> | undefined;
  let arrivals = 0;
  let responses: Schmock.Response[] = [];
  let expectedIds: string[] = [];

  Scenario(
    "Concurrent request contexts remain isolated",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an asynchronous mock that waits until every request reaches a shared rendezvous",
        () => {
          mock = schmock();
          arrivals = 0;
          mock("GET /items/:id", async ({ params }) => {
            arrivals += 1;
            if (arrivals === expectedIds.length) releaseBarrier?.();
            if (!boundedBarrier) {
              throw new Error("Concurrent rendezvous was not initialized");
            }
            await boundedBarrier;
            return { id: params.id };
          });
        },
      );

      When(
        "I issue {int} concurrent requests with distinct route IDs",
        async (_scenario, count: number) => {
          expectedIds = Array.from({ length: count }, (_, index) =>
            String(index),
          );
          const barrier = new Promise<void>((resolve) => {
            releaseBarrier = resolve;
          });
          boundedBarrier = withTimeout(
            barrier,
            2_000,
            `Timed out waiting for ${count} requests to reach the shared rendezvous`,
          );
          const pending = expectedIds.map((id) =>
            mock.handle("GET", `/items/${id}`),
          );
          responses = await Promise.all(pending);
        },
      );

      Then("every response should contain its corresponding route ID", () => {
        expect(arrivals).toBe(expectedIds.length);
        expect(responses).toHaveLength(expectedIds.length);
        expect(responses.map((response) => response.body)).toEqual(
          expectedIds.map((id) => ({ id })),
        );
      });

      And("the history should contain each route ID exactly once", () => {
        const retainedIds = mock
          .history()
          .map((record) => record.params.id)
          .sort();
        expect(retainedIds).toEqual([...expectedIds].sort());
      });
    },
  );
});
