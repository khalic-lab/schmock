import { describe, expect, it, vi } from "vitest";
import { schmock } from "./index";

describe("event system", () => {
  it("emits request:start and request:end events", async () => {
    const startHandler = vi.fn();
    const endHandler = vi.fn();

    const mock = schmock()
      .routes({
        "GET /test": {
          response: () => ({ data: "test" }),
        },
      })
      .build();

    mock.on("request:start", startHandler);
    mock.on("request:end", endHandler);

    await mock.handle("GET", "/test");

    expect(startHandler).toHaveBeenCalledWith({
      method: "GET",
      path: "/test",
    });

    expect(endHandler).toHaveBeenCalledWith({
      method: "GET",
      path: "/test",
      status: 200,
    });
  });

  it("calls multiple handlers in order", async () => {
    const order: string[] = [];
    const handlerA = vi.fn(() => order.push("A"));
    const handlerB = vi.fn(() => order.push("B"));

    const mock = schmock()
      .routes({
        "GET /test": {
          response: () => "OK",
        },
      })
      .build();

    mock.on("request:start", handlerA);
    mock.on("request:start", handlerB);

    await mock.handle("GET", "/test");

    expect(order).toEqual(["A", "B"]);
  });

  it("removes event handler", async () => {
    const handler = vi.fn();

    const mock = schmock()
      .routes({
        "GET /test": {
          response: () => "OK",
        },
      })
      .build();

    mock.on("request:start", handler);
    mock.off("request:start", handler);

    await mock.handle("GET", "/test");

    expect(handler).not.toHaveBeenCalled();
  });

  it("emits error event on handler error", async () => {
    const errorHandler = vi.fn();
    const failingHandler = vi.fn(() => {
      throw new Error("Handler error");
    });

    const mock = schmock()
      .routes({
        "GET /test": {
          response: () => "OK",
        },
      })
      .build();

    mock.on("error", errorHandler);
    mock.on("request:start", failingHandler);

    await mock.handle("GET", "/test");

    expect(errorHandler).toHaveBeenCalledWith({
      error: expect.objectContaining({
        message: "Handler error",
      }),
    });
  });

  it("emits error event on response function error", async () => {
    const errorHandler = vi.fn();

    const mock = schmock()
      .routes({
        "GET /error": {
          response: () => {
            throw new Error("Response error");
          },
        },
      })
      .build();

    mock.on("error", errorHandler);

    const response = await mock.handle("GET", "/error");

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("Response error");
    expect(response.body.code).toBe("INTERNAL_ERROR");

    expect(errorHandler).toHaveBeenCalledWith({
      error: expect.objectContaining({
        message: "Response error",
      }),
      method: "GET",
      path: "/error",
    });
  });
});
