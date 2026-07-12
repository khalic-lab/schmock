import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";

const feature = await loadFeature("../../features/state-concurrency.feature");

function readCounter(state: Record<string, unknown>): number {
  const counter = state.counter;
  if (typeof counter !== "number") throw new Error("Counter state is invalid");
  return counter;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseRecord(response: Schmock.Response): Record<string, unknown> {
  if (!isRecord(response.body)) {
    throw new Error("Expected an object response");
  }
  return response.body;
}

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
  let firstMock: Schmock.CallableMockInstance;
  let secondMock: Schmock.CallableMockInstance;
  let firstResponse: Schmock.Response;
  let secondResponse: Schmock.Response;
  let concurrentResponses: Schmock.Response[] = [];
  let expectedConcurrentCount = 0;

  Scenario(
    "Different mock instances keep independent route state",
    ({ Given, When, Then, And }) => {
      Given("I create two mocks with different counter state", () => {
        firstMock = schmock({ state: { counter: 0 } });
        secondMock = schmock({ state: { counter: 100 } });

        const registerIncrement = (mock: Schmock.CallableMockInstance) => {
          mock("POST /increment", ({ state }) => {
            const next = readCounter(state) + 1;
            state.counter = next;
            return { counter: next };
          });
        };
        registerIncrement(firstMock);
        registerIncrement(secondMock);
      });

      When("I increment both mocks concurrently", async () => {
        [firstResponse, secondResponse] = await Promise.all([
          firstMock.handle("POST", "/increment"),
          secondMock.handle("POST", "/increment"),
        ]);
      });

      Then("the first mock counter should be {int}", (_, counter: number) => {
        expect(responseRecord(firstResponse).counter).toBe(counter);
        expect(firstMock.getState().counter).toBe(counter);
      });

      And("the second mock counter should be {int}", (_, counter: number) => {
        expect(responseRecord(secondResponse).counter).toBe(counter);
        expect(secondMock.getState().counter).toBe(counter);
      });
    },
  );

  Scenario(
    "Concurrent requests keep plugin state isolated",
    ({ Given, When, Then }) => {
      let requestCount = 0;
      let arrivals = 0;
      let boundedBarrier: Promise<void> | undefined;
      let releaseBarrier: (() => void) | undefined;

      Given(
        "I create a two-stage plugin pipeline with a shared async barrier",
        () => {
          arrivals = 0;

          const firstStage: Schmock.Plugin = {
            name: "first-stage",
            async process(context, response) {
              context.state.set("request-id", context.params.id);
              arrivals += 1;
              if (arrivals === requestCount) releaseBarrier?.();
              if (!boundedBarrier) {
                throw new Error("Plugin rendezvous was not initialized");
              }
              await boundedBarrier;
              return { context, response };
            },
          };
          const secondStage: Schmock.Plugin = {
            name: "second-stage",
            process(context, response) {
              const firstStageId = context.state.get("request-id");
              return {
                context,
                response: {
                  routeId: context.params.id,
                  firstStageId,
                  original: response,
                },
              };
            },
          };

          firstMock = schmock();
          firstMock("GET /work/:id", ({ params }) => ({ id: params.id }))
            .pipe(firstStage)
            .pipe(secondStage);
        },
      );

      When(
        "I issue {int} concurrent requests with distinct IDs through the pipeline",
        async (_scenario, count: number) => {
          requestCount = count;
          expectedConcurrentCount = count;
          const barrier = new Promise<void>((resolve) => {
            releaseBarrier = resolve;
          });
          boundedBarrier = withTimeout(
            barrier,
            2_000,
            `Timed out waiting for ${count} requests to reach the plugin rendezvous`,
          );
          concurrentResponses = await Promise.all(
            Array.from({ length: count }, (_, index) =>
              firstMock.handle("GET", `/work/${index}`),
            ),
          );
        },
      );

      Then(
        "every response should contain the same ID from both plugin stages",
        () => {
          expect(arrivals).toBe(expectedConcurrentCount);
          expect(concurrentResponses).toHaveLength(expectedConcurrentCount);
          concurrentResponses.forEach((response, index) => {
            const body = responseRecord(response);
            expect(body.routeId).toBe(String(index));
            expect(body.firstStageId).toBe(String(index));
          });
        },
      );
    },
  );
});
