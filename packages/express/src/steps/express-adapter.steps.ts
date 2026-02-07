import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import type { CallableMockInstance } from "@schmock/core";
import { schmock } from "@schmock/core";
import { expect, vi } from "vitest";
import { toExpress } from "../index";

const feature = await loadFeature("../../features/express-adapter.feature");

function createMockReq(method: string, path: string) {
  return {
    method,
    path,
    headers: {},
    body: undefined,
    query: {},
  } as any;
}

function createMockRes() {
  const res: any = {
    _status: 200,
    _body: undefined,
    _headers: {} as Record<string, string>,
    _ended: false,
    status: vi.fn(function (this: any, code: number) {
      this._status = code;
      return this;
    }),
    set: vi.fn(function (this: any, key: string, value: string) {
      this._headers[key] = value;
      return this;
    }),
    json: vi.fn(function (this: any, body: unknown) {
      this._body = body;
      this._ended = true;
    }),
    send: vi.fn(function (this: any, body: unknown) {
      this._body = body;
      this._ended = true;
    }),
    end: vi.fn(function (this: any) {
      this._ended = true;
    }),
  };
  return res;
}

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let middleware: ReturnType<typeof toExpress>;
  let res: ReturnType<typeof createMockRes>;
  let next: ReturnType<typeof vi.fn>;

  Scenario(
    "Matched route returns Schmock response",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware from a Schmock mock with:",
        (_, docString: string) => {
          mock = schmock();
          new Function("mock", docString)(mock);
          middleware = toExpress(mock);
        },
      );

      When("a request is made to {string}", async (_, request: string) => {
        const [method, path] = request.split(" ");
        const req = createMockReq(method, path);
        res = createMockRes();
        next = vi.fn();
        await middleware(req, res, next);
      });

      Then(
        "the Express response should have status {int}",
        (_, status: number) => {
          expect(res.status).toHaveBeenCalledWith(status);
        },
      );

      And("the Express response body should be:", (_, docString: string) => {
        const expected = JSON.parse(docString);
        expect(res.json).toHaveBeenCalledWith(expected);
      });

      And("next should not have been called", () => {
        expect(next).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "Unmatched route calls next for passthrough",
    ({ Given, When, Then }) => {
      Given(
        "I create an Express middleware from a Schmock mock with:",
        (_, docString: string) => {
          mock = schmock();
          new Function("mock", docString)(mock);
          middleware = toExpress(mock);
        },
      );

      When("a request is made to {string}", async (_, request: string) => {
        const [method, path] = request.split(" ");
        const req = createMockReq(method, path);
        res = createMockRes();
        next = vi.fn();
        await middleware(req, res, next);
      });

      Then("next should have been called without error", () => {
        expect(next).toHaveBeenCalledWith();
      });
    },
  );

  Scenario(
    "Unmatched HTTP method calls next for passthrough",
    ({ Given, When, Then }) => {
      Given(
        "I create an Express middleware from a Schmock mock with:",
        (_, docString: string) => {
          mock = schmock();
          new Function("mock", docString)(mock);
          middleware = toExpress(mock);
        },
      );

      When("a request is made to {string}", async (_, request: string) => {
        const [method, path] = request.split(" ");
        const req = createMockReq(method, path);
        res = createMockRes();
        next = vi.fn();
        await middleware(req, res, next);
      });

      Then("next should have been called without error", () => {
        expect(next).toHaveBeenCalledWith();
      });
    },
  );

  Scenario(
    "Error status codes are sent as responses not passthrough",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware from a Schmock mock with:",
        (_, docString: string) => {
          mock = schmock();
          new Function("mock", docString)(mock);
          middleware = toExpress(mock);
        },
      );

      When("a request is made to {string}", async (_, request: string) => {
        const [method, path] = request.split(" ");
        const req = createMockReq(method, path);
        res = createMockRes();
        next = vi.fn();
        await middleware(req, res, next);
      });

      Then(
        "the Express response should have status {int}",
        (_, status: number) => {
          expect(res.status).toHaveBeenCalledWith(status);
        },
      );

      And("next should not have been called", () => {
        expect(next).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "Generator errors return 500 response",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware from a Schmock mock with:",
        (_, docString: string) => {
          mock = schmock();
          new Function("mock", docString)(mock);
          middleware = toExpress(mock);
        },
      );

      When("a request is made to {string}", async (_, request: string) => {
        const [method, path] = request.split(" ");
        const req = createMockReq(method, path);
        res = createMockRes();
        next = vi.fn();
        await middleware(req, res, next);
      });

      Then(
        "the Express response should have status {int}",
        (_, status: number) => {
          expect(res.status).toHaveBeenCalledWith(status);
        },
      );

      And("next should not have been called", () => {
        expect(next).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "Response headers are forwarded to Express",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware from a Schmock mock with:",
        (_, docString: string) => {
          mock = schmock();
          new Function("mock", docString)(mock);
          middleware = toExpress(mock);
        },
      );

      When("a request is made to {string}", async (_, request: string) => {
        const [method, path] = request.split(" ");
        const req = createMockReq(method, path);
        res = createMockRes();
        next = vi.fn();
        await middleware(req, res, next);
      });

      Then(
        "the Express response should have status {int}",
        (_, status: number) => {
          expect(res.status).toHaveBeenCalledWith(status);
        },
      );

      And(
        "the Express response should have header {string} with value {string}",
        (_, header: string, value: string) => {
          expect(res.set).toHaveBeenCalledWith(header, value);
        },
      );
    },
  );
});
