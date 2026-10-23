import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";

const feature = await loadFeature(
  "../../features/review-core-responses.feature",
);

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance | undefined;
  let intercept: Schmock.InterceptHandle | undefined;
  let fetched: Response | undefined;

  AfterEachScenario(() => {
    intercept?.restore();
    intercept = undefined;
    mock = undefined;
    fetched = undefined;
  });

  function currentMock(): Schmock.CallableMockInstance {
    if (!mock) throw new Error("scenario did not create a mock");
    return mock;
  }

  function currentResponse(): Response {
    if (!fetched) throw new Error("scenario did not fetch anything");
    return fetched;
  }

  async function fetchThroughIntercept(path: string): Promise<void> {
    intercept = currentMock().intercept({ passthrough: false });
    fetched = await fetch(`http://localhost${path}`);
  }

  // ── Response bodies ────────────────────────────────────────────────────

  Scenario(
    "A route returning a Date sends a JSON string literal",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock whose route "GET /time" returns the Date 1970-01-01T00:00:00.000Z',
        () => {
          mock = schmock();
          mock("GET /time", () => new Date(0));
        },
      );

      When('I fetch "/time" through intercept', async () => {
        await fetchThroughIntercept("/time");
      });

      Then('the response content type is "application/json"', () => {
        expect(currentResponse().headers.get("content-type")).toBe(
          "application/json",
        );
      });

      And(
        'the response body parses as the JSON string "1970-01-01T00:00:00.000Z"',
        async () => {
          const parsed: unknown = JSON.parse(await currentResponse().text());
          expect(parsed).toBe("1970-01-01T00:00:00.000Z");
        },
      );
    },
  );
});
