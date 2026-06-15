import { describe, expect, it } from "vitest";
import { schmock } from "./index";

describe("isResponseObject guard — status type check", () => {
  describe("non-numeric status must NOT be treated as response envelope", () => {
    it("returns status 200 (default) when generator returns { status: 'ok', body: 'hello' }", async () => {
      const mock = schmock();
      mock("GET /bad-envelope", () => ({ status: "ok", body: "hello" }));

      const response = await mock.handle("GET", "/bad-envelope");

      // The string status must never leak into response.status
      expect(response.status).toBe(200);
    });

    it("returns the whole object as body when generator returns { status: 'ok', body: 'hello' }", async () => {
      const mock = schmock();
      mock("GET /bad-envelope-body", () => ({ status: "ok", body: "hello" }));

      const response = await mock.handle("GET", "/bad-envelope-body");

      // The original object must be treated as plain body, not unwrapped
      expect(response.body).toEqual({ status: "ok", body: "hello" });
    });
  });

  describe("numeric status IS correctly treated as response envelope", () => {
    it("returns status 201 and unwrapped body when generator returns { status: 201, body: { id: 1 } }", async () => {
      const mock = schmock();
      mock("POST /create", () => ({ status: 201, body: { id: 1 } }));

      const response = await mock.handle("POST", "/create");

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ id: 1 });
    });
  });
});
