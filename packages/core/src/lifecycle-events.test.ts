import { describe, expect, it } from "vitest";
import { schmock } from "./index.js";

describe("lifecycle event isolation", () => {
  it("consumes rejected listener promises without changing the response", async () => {
    const mock = schmock();
    mock("GET /events", { ok: true });
    mock.on("request:start", async () => {
      throw new Error("observer rejected");
    });

    const response = await mock.handle("GET", "/events");
    await Promise.resolve();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});
