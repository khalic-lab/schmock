import { describe, expect, it } from "vitest";
import { createGuardedFetch } from "./ref-transport.js";

describe("createGuardedFetch", () => {
  describe("host resolution failures", () => {
    it("describes a resolver that rejects with a non-Error as core does, keeping it as the cause", async () => {
      const thrown = { code: "EAI_AGAIN" };
      const fetchRef = createGuardedFetch({
        resolveHost: () => Promise.reject(thrown),
      });

      const failure = await fetchRef("http://schemas.example.com/m.json", {
        signal: AbortSignal.timeout(5_000),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        message: '{"code":"EAI_AGAIN"}',
        cause: thrown,
      });
    });
  });
});
