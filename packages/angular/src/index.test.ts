// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import {
  HTTP_INTERCEPTORS,
  HttpErrorResponse,
  type HttpEvent,
  type HttpHandler,
  HttpHeaders,
  HttpParams,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import type * as Schmock from "@schmock/core";
import type { CallableMockInstance } from "@schmock/core";
import { of } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSchmockInterceptor, provideSchmockInterceptor } from "./index";

describe("Angular Adapter", () => {
  let mockInstance: CallableMockInstance;

  beforeEach(() => {
    mockInstance = {
      handle: vi.fn(),
      pipe: vi.fn(),
    } as any; // Use any to avoid complex mock setup for callable interface
  });

  describe("createSchmockInterceptor", () => {
    it("creates an interceptor class", () => {
      const InterceptorClass = createSchmockInterceptor(mockInstance);

      expect(InterceptorClass).toBeDefined();
      expect(InterceptorClass).toBeTypeOf("function");
      expect(InterceptorClass.name).toBe("SchmockInterceptor");
    });

    it("creates interceptor instance that handles requests", async () => {
      const mockResponse = {
        status: 200,
        body: { data: "mocked" },
        headers: {},
      };

      mockInstance.handle = vi.fn().mockResolvedValue(mockResponse);

      const InterceptorClass = createSchmockInterceptor(mockInstance);
      const interceptor = new InterceptorClass();

      // Create mock request and handler
      const mockRequest = new HttpRequest("GET", "/api/test");
      const mockNext: HttpHandler = {
        handle: vi.fn().mockReturnValue(of(new HttpResponse({ body: "real" }))),
      };

      // Call intercept
      const result$ = interceptor.intercept(mockRequest, mockNext);

      // Collect emitted values
      const emittedValues: HttpEvent<any>[] = [];

      await new Promise<void>((resolve, reject) => {
        result$.subscribe({
          next: (value) => emittedValues.push(value),
          complete: () => resolve(),
          error: (err) => reject(err),
        });
      });

      // Verify handle was called
      expect(mockInstance.handle).toHaveBeenCalledWith(
        "GET",
        "/api/test",
        expect.objectContaining({
          headers: {},
          body: null,
          query: {},
          signal: expect.any(AbortSignal),
        }),
      );

      // Verify response
      expect(emittedValues).toHaveLength(1);
      const response = emittedValues[0] as HttpResponse<any>;
      expect(response.body).toEqual({ data: "mocked" });
      expect(response.status).toBe(200);
    });

    it("passes through when no route matches", async () => {
      // Schmock core returns a 404 with ROUTE_NOT_FOUND for unmatched routes
      mockInstance.handle = vi.fn().mockResolvedValue({
        status: 404,
        body: {
          error: "Route not found: GET /api/test",
          code: "ROUTE_NOT_FOUND",
        },
      });

      const InterceptorClass = createSchmockInterceptor(mockInstance);
      const interceptor = new InterceptorClass();

      const mockRequest = new HttpRequest("GET", "/api/test");
      const realResponse = new HttpResponse({ body: "real backend" });
      const mockNext: HttpHandler = {
        handle: vi.fn().mockReturnValue(of(realResponse)),
      };

      const result$ = interceptor.intercept(mockRequest, mockNext);
      const emittedValues: HttpEvent<any>[] = [];

      await new Promise<void>((resolve) => {
        result$.subscribe({
          next: (value) => emittedValues.push(value),
          complete: () => resolve(),
        });
      });

      expect(mockNext.handle).toHaveBeenCalledWith(mockRequest);
      expect(emittedValues[0]).toBe(realResponse);
    });

    it("returns 404 when passthrough is false", async () => {
      // Schmock core returns a 404 with ROUTE_NOT_FOUND for unmatched routes
      mockInstance.handle = vi.fn().mockResolvedValue({
        status: 404,
        body: {
          error: "Route not found: GET /api/test",
          code: "ROUTE_NOT_FOUND",
        },
      });

      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        passthrough: false,
      });
      const interceptor = new InterceptorClass();

      const mockRequest = new HttpRequest("GET", "/api/test");
      const mockNext: HttpHandler = {
        handle: vi.fn(),
      };

      const result$ = interceptor.intercept(mockRequest, mockNext);
      let error: any;

      await new Promise<void>((resolve) => {
        result$.subscribe({
          error: (err) => {
            error = err;
            resolve();
          },
        });
      });

      expect(error).toBeInstanceOf(HttpErrorResponse);
      expect(error.status).toBe(404);
      expect(error.error.message).toBe("No matching mock route found");
    });

    it("returns a bodyless 404 for unmatched HEAD in strict mode", async () => {
      mockInstance.handle = vi.fn().mockResolvedValue({
        status: 404,
        body: { error: "Route not found", code: "ROUTE_NOT_FOUND" },
        headers: { "content-type": "application/json" },
      });
      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        passthrough: false,
      });
      const interceptor = new InterceptorClass();
      let responseError: HttpErrorResponse | undefined;

      await new Promise<void>((resolve) => {
        interceptor
          .intercept(new HttpRequest("HEAD", "/api/missing"), {
            handle: vi.fn(),
          })
          .subscribe({
            error: (error: HttpErrorResponse) => {
              responseError = error;
              resolve();
            },
          });
      });

      expect(responseError?.status).toBe(404);
      expect(responseError?.error ?? null).toBeNull();
    });
  });

  describe("configuration options", () => {
    it("respects baseUrl option", async () => {
      mockInstance.handle = vi
        .fn()
        .mockResolvedValue({ status: 200, body: "ok" });

      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        baseUrl: "/api",
      });
      const interceptor = new InterceptorClass();

      // Request to /api should be intercepted
      const apiRequest = new HttpRequest("GET", "/api/test");
      const mockNext: HttpHandler = {
        handle: vi.fn(),
      };

      await new Promise<void>((resolve) => {
        interceptor
          .intercept(apiRequest, mockNext)
          .subscribe({ complete: resolve });
      });

      expect(mockInstance.handle).toHaveBeenCalled();

      // Request to /other should pass through
      mockInstance.handle = vi.fn();
      const otherRequest = new HttpRequest("GET", "/other/test");
      const realResponse = new HttpResponse({ body: "real" });
      mockNext.handle = vi.fn().mockReturnValue(of(realResponse));

      await new Promise<void>((resolve) => {
        interceptor
          .intercept(otherRequest, mockNext)
          .subscribe({ complete: resolve });
      });

      expect(mockInstance.handle).not.toHaveBeenCalled();
      expect(mockNext.handle).toHaveBeenCalledWith(otherRequest);
    });

    it("does not treat a sibling path as part of baseUrl", async () => {
      mockInstance.handle = vi.fn();
      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        baseUrl: "/api",
        passthrough: false,
      });
      const interceptor = new InterceptorClass();
      const request = new HttpRequest("GET", "/apiv2/users");
      const backendResponse = new HttpResponse({ body: "real" });
      const next: HttpHandler = {
        handle: vi.fn().mockReturnValue(of(backendResponse)),
      };

      const result = await new Promise<HttpEvent<unknown>>(
        (resolve, reject) => {
          interceptor.intercept(request, next).subscribe({
            next: resolve,
            error: reject,
          });
        },
      );

      expect(result).toBe(backendResponse);
      expect(mockInstance.handle).not.toHaveBeenCalled();
      expect(next.handle).toHaveBeenCalledWith(request);
    });

    it("passes unsupported methods through without changing them to GET", async () => {
      mockInstance.handle = vi.fn();
      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        passthrough: false,
      });
      const interceptor = new InterceptorClass();
      const request = new HttpRequest<unknown>(
        "PROPFIND",
        "/api/users",
        undefined,
        {},
      );
      const backendResponse = new HttpResponse({ body: "real" });
      const next: HttpHandler = {
        handle: vi.fn().mockReturnValue(of(backendResponse)),
      };

      const result = await new Promise<HttpEvent<unknown>>(
        (resolve, reject) => {
          interceptor.intercept(request, next).subscribe({
            next: resolve,
            error: reject,
          });
        },
      );

      expect(result).toBe(backendResponse);
      expect(mockInstance.handle).not.toHaveBeenCalled();
      expect(next.handle).toHaveBeenCalledWith(request);
    });

    it("strips baseUrl prefix before passing path to mock.handle", async () => {
      mockInstance.handle = vi
        .fn()
        .mockResolvedValue({ status: 200, body: "ok", headers: {} });

      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        baseUrl: "/api",
      });
      const interceptor = new InterceptorClass();

      const apiRequest = new HttpRequest("GET", "/api/users");
      const mockNext: HttpHandler = { handle: vi.fn() };

      await new Promise<void>((resolve) => {
        interceptor
          .intercept(apiRequest, mockNext)
          .subscribe({ complete: resolve });
      });

      // Route path passed to handle should be '/users', not '/api/users'
      expect(mockInstance.handle).toHaveBeenCalledWith(
        "GET",
        "/users",
        expect.any(Object),
      );
    });

    it("passes '/' when request path equals baseUrl exactly", async () => {
      mockInstance.handle = vi
        .fn()
        .mockResolvedValue({ status: 200, body: "ok", headers: {} });

      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        baseUrl: "/api",
      });
      const interceptor = new InterceptorClass();

      const apiRequest = new HttpRequest("GET", "/api");
      const mockNext: HttpHandler = { handle: vi.fn() };

      await new Promise<void>((resolve) => {
        interceptor
          .intercept(apiRequest, mockNext)
          .subscribe({ complete: resolve });
      });

      expect(mockInstance.handle).toHaveBeenCalledWith(
        "GET",
        "/",
        expect.any(Object),
      );
    });

    it("uses custom error formatter", async () => {
      const error = new Error("Test error");
      mockInstance.handle = vi.fn().mockRejectedValue(error);

      const errorFormatter = vi.fn((err) => ({
        custom: true,
        message: err.message,
      }));

      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        errorFormatter,
      });
      const interceptor = new InterceptorClass();

      const mockRequest = new HttpRequest("GET", "/api/test");
      const mockNext: HttpHandler = { handle: vi.fn() };

      let errorResponse: any;
      await new Promise<void>((resolve) => {
        interceptor.intercept(mockRequest, mockNext).subscribe({
          error: (err) => {
            errorResponse = err;
            resolve();
          },
        });
      });

      expect(errorFormatter).toHaveBeenCalledWith(error, mockRequest);
      expect(errorResponse.error).toEqual({
        custom: true,
        message: "Test error",
      });
    });

    it("settles the Observable when the formatter output is not serializable", async () => {
      const error = new Error("Test error");
      mockInstance.handle = vi.fn().mockRejectedValue(error);
      // An embedded Error is rejected by the response normalizer; the
      // interceptor must still emit observer.error instead of throwing
      // inside the handler and hanging the HttpClient request forever.
      const errorFormatter = vi.fn((err: Error) => ({ cause: err }));

      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        errorFormatter,
      });
      const interceptor = new InterceptorClass();

      const mockRequest = new HttpRequest("GET", "/api/test");
      const mockNext: HttpHandler = { handle: vi.fn() };

      let errorResponse: any;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Observable never settled")),
          2_000,
        );
        interceptor.intercept(mockRequest, mockNext).subscribe({
          error: (err) => {
            clearTimeout(timeout);
            errorResponse = err;
            resolve();
          },
        });
      });

      expect(errorFormatter).toHaveBeenCalledTimes(1);
      expect(errorResponse.status).toBe(500);
      expect(errorResponse.error).toEqual({
        error: "Internal Server Error",
        code: "INTERNAL_ERROR",
      });
    });

    it("settles the Observable when the formatter itself throws", async () => {
      const error = new Error("handler failed");
      mockInstance.handle = vi.fn().mockRejectedValue(error);
      // Nothing downstream catches a throw from inside the .catch handler:
      // the Observable would never settle. The interceptor must fall back
      // to the default error body instead.
      const errorFormatter = vi.fn(() => {
        throw new Error("formatter exploded");
      });

      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        errorFormatter,
      });
      const interceptor = new InterceptorClass();

      const mockRequest = new HttpRequest("GET", "/api/test");
      const mockNext: HttpHandler = { handle: vi.fn() };

      let errorResponse: any;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Observable never settled")),
          2_000,
        );
        interceptor.intercept(mockRequest, mockNext).subscribe({
          error: (err) => {
            clearTimeout(timeout);
            errorResponse = err;
            resolve();
          },
        });
      });

      expect(errorFormatter).toHaveBeenCalledTimes(1);
      expect(errorResponse.status).toBe(500);
      expect(errorResponse.error).toEqual({
        error: "handler failed",
        code: "INTERNAL_ERROR",
      });
    });

    it("formats a resolved exception 500 once even when the formatter throws", async () => {
      // A resolved 500 marked as a core exception reaches the formatter in
      // the .then path; a throw there must not fall into .catch, where the
      // formatter would fire a second time with its own exception.
      const marked = {
        status: 500,
        body: { error: "route blew up", code: "INTERNAL_ERROR" },
        headers: { "content-type": "application/json" },
      };
      Object.defineProperty(
        marked,
        Symbol.for("@schmock/core.response-origin"),
        {
          configurable: true,
          value: { kind: "exception", error: new Error("route blew up") },
        },
      );
      mockInstance.handle = vi.fn().mockResolvedValue(marked);
      const errorFormatter = vi.fn(() => {
        throw new Error("formatter exploded");
      });

      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        errorFormatter,
      });
      const interceptor = new InterceptorClass();

      let errorResponse: any;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Observable never settled")),
          2_000,
        );
        interceptor
          .intercept(new HttpRequest("GET", "/api/test"), {
            handle: vi.fn(),
          })
          .subscribe({
            error: (err) => {
              clearTimeout(timeout);
              errorResponse = err;
              resolve();
            },
          });
      });

      expect(errorFormatter).toHaveBeenCalledTimes(1);
      expect(errorResponse.status).toBe(500);
      expect(errorResponse.error).toEqual({
        error: "Internal Server Error",
        code: "INTERNAL_ERROR",
      });
    });

    it("does not format a deliberate domain 500 as an exception", async () => {
      mockInstance.handle = vi.fn().mockResolvedValue({
        status: 500,
        body: { error: "declined", code: "DOMAIN_DECLINED" },
        headers: { "content-type": "application/json" },
      });
      const errorFormatter = vi.fn(() => ({ formatted: true }));
      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        errorFormatter,
      });
      const interceptor = new InterceptorClass();
      let responseError: HttpErrorResponse | undefined;

      await new Promise<void>((resolve) => {
        interceptor
          .intercept(new HttpRequest("GET", "/api/domain-error"), {
            handle: vi.fn(),
          })
          .subscribe({
            error: (error: HttpErrorResponse) => {
              responseError = error;
              resolve();
            },
          });
      });

      expect(errorFormatter).not.toHaveBeenCalled();
      expect(responseError?.error).toEqual({
        error: "declined",
        code: "DOMAIN_DECLINED",
      });
    });

    it("uses a transformed HEAD method when formatting adapter errors", async () => {
      mockInstance.handle = vi.fn().mockRejectedValue(new Error("failed"));
      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        transformRequest: () => ({ method: "HEAD" }),
        errorFormatter: (error) => ({ error: error.message }),
      });
      const interceptor = new InterceptorClass();
      let responseError: HttpErrorResponse | undefined;

      await new Promise<void>((resolve) => {
        interceptor
          .intercept(new HttpRequest("GET", "/api/failure"), {
            handle: vi.fn(),
          })
          .subscribe({
            error: (error: HttpErrorResponse) => {
              responseError = error;
              resolve();
            },
          });
      });

      expect(responseError?.status).toBe(500);
      expect(responseError?.error ?? null).toBeNull();
    });
  });

  describe("transformRequest option", () => {
    it("applies request transformation before handling", async () => {
      mockInstance.handle = vi
        .fn()
        .mockResolvedValue({ status: 200, body: "ok", headers: {} });

      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        transformRequest: () => ({
          method: "POST",
          path: "/transformed",
          headers: { "x-custom": "value" },
        }),
      });
      const interceptor = new InterceptorClass();

      const mockRequest = new HttpRequest("GET", "/api/test");
      const mockNext: HttpHandler = { handle: vi.fn() };

      await new Promise<void>((resolve) => {
        interceptor
          .intercept(mockRequest, mockNext)
          .subscribe({ complete: resolve });
      });

      expect(mockInstance.handle).toHaveBeenCalledWith(
        "POST",
        "/transformed",
        expect.objectContaining({ headers: { "x-custom": "value" } }),
      );
    });
  });

  describe("transformResponse option", () => {
    it("applies response transformation before returning", async () => {
      mockInstance.handle = vi
        .fn()
        .mockResolvedValue({ status: 200, body: "original", headers: {} });

      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        transformResponse: (schmockResponse) => ({
          ...schmockResponse,
          status: 201,
          body: "transformed",
        }),
      });
      const interceptor = new InterceptorClass();

      const mockRequest = new HttpRequest("GET", "/api/test");
      const mockNext: HttpHandler = { handle: vi.fn() };

      const emittedValues: HttpEvent<any>[] = [];
      await new Promise<void>((resolve) => {
        interceptor.intercept(mockRequest, mockNext).subscribe({
          next: (value) => emittedValues.push(value),
          complete: resolve,
        });
      });

      const response = emittedValues[0] as HttpResponse<any>;
      expect(response.status).toBe(201);
      expect(response.body).toBe("transformed");
    });

    it("suppresses a body added to a transformed 204 response", async () => {
      mockInstance.handle = vi
        .fn()
        .mockResolvedValue({ status: 200, body: "original", headers: {} });

      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        transformResponse: (schmockResponse) => ({
          ...schmockResponse,
          status: 204,
          body: { forbidden: true },
        }),
      });
      const interceptor = new InterceptorClass();
      const mockRequest = new HttpRequest("GET", "/api/test");
      const mockNext: HttpHandler = { handle: vi.fn() };
      let response: HttpResponse<unknown> | undefined;

      await new Promise<void>((resolve, reject) => {
        interceptor.intercept(mockRequest, mockNext).subscribe({
          next: (event) => {
            if (event instanceof HttpResponse) response = event;
          },
          complete: resolve,
          error: reject,
        });
      });

      expect(response?.status).toBe(204);
      expect(response?.body).toBeNull();
    });
  });

  describe("error handling without formatter", () => {
    it("returns default error body for Error instances", async () => {
      mockInstance.handle = vi
        .fn()
        .mockRejectedValue(new Error("Something broke"));

      const InterceptorClass = createSchmockInterceptor(mockInstance);
      const interceptor = new InterceptorClass();

      const mockRequest = new HttpRequest("GET", "/api/test");
      const mockNext: HttpHandler = { handle: vi.fn() };

      let errorResponse: any;
      await new Promise<void>((resolve) => {
        interceptor.intercept(mockRequest, mockNext).subscribe({
          error: (err) => {
            errorResponse = err;
            resolve();
          },
        });
      });

      expect(errorResponse).toBeInstanceOf(HttpErrorResponse);
      expect(errorResponse.status).toBe(500);
      expect(errorResponse.error).toEqual({
        error: "Something broke",
        code: "INTERNAL_ERROR",
      });
    });

    it("returns generic error body for non-Error throws", async () => {
      mockInstance.handle = vi.fn().mockRejectedValue("string error");

      const InterceptorClass = createSchmockInterceptor(mockInstance);
      const interceptor = new InterceptorClass();

      const mockRequest = new HttpRequest("GET", "/api/test");
      const mockNext: HttpHandler = { handle: vi.fn() };

      let errorResponse: any;
      await new Promise<void>((resolve) => {
        interceptor.intercept(mockRequest, mockNext).subscribe({
          error: (err) => {
            errorResponse = err;
            resolve();
          },
        });
      });

      expect(errorResponse.error).toEqual({
        error: "Internal Server Error",
        code: "INTERNAL_ERROR",
      });
    });
  });

  describe("URL parsing", () => {
    it("extracts query parameters from URL", async () => {
      mockInstance.handle = vi
        .fn()
        .mockResolvedValue({ status: 200, body: "ok", headers: {} });

      const InterceptorClass = createSchmockInterceptor(mockInstance);
      const interceptor = new InterceptorClass();

      const mockRequest = new HttpRequest("GET", "/api/test?page=1&limit=10");
      const mockNext: HttpHandler = { handle: vi.fn() };

      await new Promise<void>((resolve) => {
        interceptor
          .intercept(mockRequest, mockNext)
          .subscribe({ complete: resolve });
      });

      expect(mockInstance.handle).toHaveBeenCalledWith(
        "GET",
        "/api/test",
        expect.objectContaining({ query: { page: "1", limit: "10" } }),
      );
    });
  });

  describe("subscription teardown", () => {
    it("aborts a pending core request on teardown", () => {
      mockInstance.handle = vi.fn(
        () => new Promise<Schmock.Response>(() => undefined),
      );
      const InterceptorClass = createSchmockInterceptor(mockInstance);
      const interceptor = new InterceptorClass();
      const request = new HttpRequest("GET", "/api/pending");
      const subscription = interceptor
        .intercept(request, { handle: vi.fn() })
        .subscribe();

      const requestOptions: unknown = vi.mocked(mockInstance.handle).mock
        .calls[0]?.[2];
      if (
        typeof requestOptions !== "object" ||
        requestOptions === null ||
        !("signal" in requestOptions) ||
        !(requestOptions.signal instanceof AbortSignal)
      ) {
        throw new Error("Expected an AbortSignal in request options");
      }

      subscription.unsubscribe();

      expect(requestOptions.signal.aborted).toBe(true);
    });

    it("does not emit or format after teardown", async () => {
      let resolveRequest = (_response: Schmock.Response) => {};
      mockInstance.handle = vi.fn(
        () =>
          new Promise<Schmock.Response>((resolve) => {
            resolveRequest = resolve;
          }),
      );
      const errorFormatter = vi.fn(() => ({ formatted: true }));
      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        errorFormatter,
      });
      const interceptor = new InterceptorClass();
      const next = vi.fn();
      const error = vi.fn();
      const complete = vi.fn();
      const subscription = interceptor
        .intercept(new HttpRequest("GET", "/api/pending"), {
          handle: vi.fn(),
        })
        .subscribe({ next, error, complete });

      subscription.unsubscribe();
      resolveRequest({ status: 200, body: { late: true }, headers: {} });
      await Promise.resolve();
      await Promise.resolve();

      expect(next).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(errorFormatter).not.toHaveBeenCalled();
    });

    it("unsubscribes from inner subscription on teardown", async () => {
      mockInstance.handle = vi.fn().mockResolvedValue({
        status: 404,
        body: { error: "Route not found", code: "ROUTE_NOT_FOUND" },
        headers: {},
      });

      const InterceptorClass = createSchmockInterceptor(mockInstance);
      const interceptor = new InterceptorClass();

      const mockRequest = new HttpRequest("GET", "/api/test");
      const realResponse = new HttpResponse({ body: "real" });
      const mockNext: HttpHandler = {
        handle: vi.fn().mockReturnValue(of(realResponse)),
      };

      const result$ = interceptor.intercept(mockRequest, mockNext);
      const subscription = result$.subscribe();

      // Allow promise to resolve
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should not throw when unsubscribing
      subscription.unsubscribe();
    });
  });

  describe("request header casing", () => {
    async function capturedHeaders(
      options?: Parameters<typeof createSchmockInterceptor>[1],
      requestHeaders?: Record<string, string>,
    ): Promise<Record<string, string>> {
      mockInstance.handle = vi
        .fn()
        .mockResolvedValue({ status: 200, body: "ok", headers: {} });
      const InterceptorClass = createSchmockInterceptor(mockInstance, options);
      const interceptor = new InterceptorClass();
      const request = new HttpRequest("GET", "/api/test", null, {
        headers: new HttpHeaders(requestHeaders),
      });

      await new Promise<void>((resolve, reject) => {
        interceptor
          .intercept(request, { handle: vi.fn() })
          .subscribe({ complete: resolve, error: reject });
      });

      const options0: any = vi.mocked(mockInstance.handle).mock.calls[0]?.[2];
      return options0.headers;
    }

    it("lowercases caller-supplied header names", async () => {
      // Angular's HttpHeaders.keys() preserves the caller's casing, so
      // without folding a handler reading headers.authorization sees nothing.
      expect(
        await capturedHeaders(undefined, {
          Authorization: "Bearer token123",
          "X-Tenant": "acme",
        }),
      ).toEqual({ authorization: "Bearer token123", "x-tenant": "acme" });
    });

    it("lowercases capitalized keys returned by transformRequest", async () => {
      // transformRequest replaces requestData.headers wholesale, so folding
      // must happen at the mock.handle choke point, not in headersToObject.
      expect(
        await capturedHeaders({
          transformRequest: () => ({ headers: { "X-Override": "yes" } }),
        }),
      ).toEqual({ "x-override": "yes" });
    });
  });

  describe("responseType shaping", () => {
    function interceptOnce(
      response: Schmock.Response | Promise<Schmock.Response>,
      responseType: "arraybuffer" | "blob" | "json" | "text",
      options?: Parameters<typeof createSchmockInterceptor>[1],
      method: "GET" | "HEAD" = "GET",
    ) {
      mockInstance.handle = vi.fn().mockResolvedValue(response);
      const InterceptorClass = createSchmockInterceptor(mockInstance, options);
      const interceptor = new InterceptorClass();
      const request =
        method === "HEAD"
          ? new HttpRequest("HEAD", "/api/test", { responseType })
          : new HttpRequest("GET", "/api/test", null, { responseType });

      return new Promise<{
        response?: HttpResponse<unknown>;
        error?: HttpErrorResponse;
      }>((resolve) => {
        interceptor.intercept(request, { handle: vi.fn() }).subscribe({
          next: (event) => {
            if (event instanceof HttpResponse) resolve({ response: event });
          },
          error: (error: HttpErrorResponse) => resolve({ error }),
        });
      });
    }

    it("converts an object body to a string for responseType text", async () => {
      const { response } = await interceptOnce(
        { status: 200, body: { users: [] }, headers: {} },
        "text",
      );

      expect(response?.body).toBe('{"users":[]}');
    });

    it("converts the error channel body for responseType text", async () => {
      const { error } = await interceptOnce(
        { status: 400, body: { message: "bad" }, headers: {} },
        "text",
      );

      expect(error?.error).toBe('{"message":"bad"}');
    });

    it("converts a formatter body on the error channel too", async () => {
      const marked = {
        status: 500,
        body: { error: "route blew up", code: "INTERNAL_ERROR" },
        headers: { "content-type": "application/json" },
      };
      Object.defineProperty(
        marked,
        Symbol.for("@schmock/core.response-origin"),
        {
          configurable: true,
          value: { kind: "exception", error: new Error("route blew up") },
        },
      );

      const { error } = await interceptOnce(marked, "text", {
        errorFormatter: () => ({ formatted: true }),
      });

      expect(error?.error).toBe('{"formatted":true}');
    });

    it("labels a formatted error Blob as JSON, not the route's media type", async () => {
      const marked = {
        status: 500,
        body: "plain text failure",
        headers: { "content-type": "text/plain" },
      };
      Object.defineProperty(
        marked,
        Symbol.for("@schmock/core.response-origin"),
        {
          configurable: true,
          value: { kind: "exception", error: new Error("route blew up") },
        },
      );

      const { error } = await interceptOnce(marked, "blob", {
        errorFormatter: () => ({ formatted: true }),
      });

      if (typeof Blob === "function") {
        expect(error?.error).toBeInstanceOf(Blob);
        expect((error?.error as Blob).type).toBe("application/json");
        expect(await (error?.error as Blob).text()).toBe('{"formatted":true}');
      } else {
        expect(error?.error).toBeInstanceOf(ArrayBuffer);
      }
    });

    it("yields an ArrayBuffer for responseType arraybuffer", async () => {
      const { response } = await interceptOnce(
        { status: 200, body: { ok: true }, headers: {} },
        "arraybuffer",
      );

      expect(response?.body).toBeInstanceOf(ArrayBuffer);
      expect(new TextDecoder().decode(response?.body as ArrayBuffer)).toBe(
        '{"ok":true}',
      );
    });

    it("yields a Blob for responseType blob when Blob exists", async () => {
      const { response } = await interceptOnce(
        {
          status: 200,
          body: { ok: true },
          headers: { "Content-Type": "application/json" },
        },
        "blob",
      );

      if (typeof Blob === "function") {
        expect(response?.body).toBeInstanceOf(Blob);
        expect((response?.body as Blob).type).toBe("application/json");
        expect(await (response?.body as Blob).text()).toBe('{"ok":true}');
      } else {
        expect(response?.body).toBeInstanceOf(ArrayBuffer);
      }
    });

    it("leaves a string body untouched for responseType json", async () => {
      // 'json' is typed any/T, so a pre-serialized string is legal; parsing
      // would silently turn a route returning 'true' into a boolean.
      const { response } = await interceptOnce(
        { status: 200, body: "true", headers: {} },
        "json",
      );

      expect(response?.body).toBe("true");
    });

    it("keeps a 204 body null under responseType text", async () => {
      const { response } = await interceptOnce(
        { status: 204, body: { forbidden: true }, headers: {} },
        "text",
      );

      expect(response?.status).toBe(204);
      expect(response?.body).toBeNull();
    });

    it("keeps a 204 body null under responseType arraybuffer and blob", async () => {
      // 204 is the single status HttpXhrBackend nulls; the empty
      // representation must not leak into it.
      const bufferResult = await interceptOnce(
        { status: 204, body: { forbidden: true }, headers: {} },
        "arraybuffer",
      );
      const blobResult = await interceptOnce(
        { status: 204, body: { forbidden: true }, headers: {} },
        "blob",
      );

      expect(bufferResult.response?.body).toBeNull();
      expect(blobResult.response?.body).toBeNull();
    });

    it("yields an empty string for an explicitly null body under responseType text", async () => {
      // Angular nulls the body only at 204; at 200 an empty payload reaches
      // the subscriber as '', so `res.trim()` works against the mock exactly
      // as it does against a real backend.
      const { response } = await interceptOnce(
        { status: 200, body: null, headers: {} },
        "text",
      );

      expect(response?.body).toBe("");
    });

    it("yields an empty ArrayBuffer for a null body under responseType arraybuffer", async () => {
      const { response } = await interceptOnce(
        { status: 200, body: null, headers: {} },
        "arraybuffer",
      );

      expect(response?.body).toBeInstanceOf(ArrayBuffer);
      expect((response?.body as ArrayBuffer).byteLength).toBe(0);
    });

    it("yields an empty Blob labelled from content-type for a null body under responseType blob", async () => {
      const { response } = await interceptOnce(
        {
          status: 200,
          body: null,
          headers: { "Content-Type": "application/json" },
        },
        "blob",
      );

      if (typeof Blob === "function") {
        expect(response?.body).toBeInstanceOf(Blob);
        expect((response?.body as Blob).size).toBe(0);
        expect((response?.body as Blob).type).toBe("application/json");
      } else {
        expect(response?.body).toBeInstanceOf(ArrayBuffer);
        expect((response?.body as ArrayBuffer).byteLength).toBe(0);
      }
    });

    it("keeps a null body null under responseType json", async () => {
      // 'json' is faithful already: real Angular parses an empty payload to
      // null, so the empty representation must not touch it.
      const { response } = await interceptOnce(
        { status: 200, body: null, headers: {} },
        "json",
      );

      expect(response?.body).toBeNull();
    });

    it("yields an empty string for a HEAD response under responseType text", async () => {
      // The body is stripped for HEAD, but the status is 200, so Angular
      // still hands the subscriber ''.
      const { response } = await interceptOnce(
        { status: 200, body: { users: [] }, headers: {} },
        "text",
        undefined,
        "HEAD",
      );

      expect(response?.status).toBe(200);
      expect(response?.body).toBe("");
    });

    it("yields an empty string for a 205 under responseType text", async () => {
      const { response } = await interceptOnce(
        { status: 205, body: { forbidden: true }, headers: {} },
        "text",
      );

      expect(response?.status).toBe(205);
      expect(response?.body).toBe("");
    });

    it("yields an empty ArrayBuffer for a 304 under responseType arraybuffer", async () => {
      // 304 is not 2xx, so it arrives through the error channel. An empty
      // ArrayBuffer is truthy and survives HttpErrorResponse's `|| null`.
      const { error } = await interceptOnce(
        { status: 304, body: { forbidden: true }, headers: {} },
        "arraybuffer",
      );

      expect(error?.status).toBe(304);
      expect(error?.error).toBeInstanceOf(ArrayBuffer);
      expect((error?.error as ArrayBuffer).byteLength).toBe(0);
    });
  });

  describe("emitted response URL", () => {
    function requestWithParams() {
      return new HttpRequest("GET", "/api/users?a=1", null, {
        params: new HttpParams({ fromObject: { b: "2" } }),
      });
    }

    async function emittedUrl(
      response: Schmock.Response,
      options?: Parameters<typeof createSchmockInterceptor>[1],
    ): Promise<string | null | undefined> {
      mockInstance.handle = vi.fn().mockResolvedValue(response);
      const InterceptorClass = createSchmockInterceptor(mockInstance, options);
      const interceptor = new InterceptorClass();

      return new Promise((resolve) => {
        interceptor
          .intercept(requestWithParams(), { handle: vi.fn() })
          .subscribe({
            next: (event) => {
              if (event instanceof HttpResponse) resolve(event.url);
            },
            error: (error: HttpErrorResponse) => resolve(error.url),
          });
      });
    }

    it("reports urlWithParams on a successful response", async () => {
      expect(await emittedUrl({ status: 200, body: "ok", headers: {} })).toBe(
        "/api/users?a=1&b=2",
      );
    });

    it("reports urlWithParams on a non-2xx error", async () => {
      expect(await emittedUrl({ status: 418, body: "nope", headers: {} })).toBe(
        "/api/users?a=1&b=2",
      );
    });

    it("reports urlWithParams on the strict-mode 404", async () => {
      expect(
        await emittedUrl(
          {
            status: 404,
            body: { error: "Route not found", code: "ROUTE_NOT_FOUND" },
            headers: {},
          },
          { passthrough: false },
        ),
      ).toBe("/api/users?a=1&b=2");
    });
  });

  describe("request-side error boundary", () => {
    it("shapes a throwing transformRequest into a formatted HttpErrorResponse", async () => {
      mockInstance.handle = vi.fn();
      const errorFormatter = vi.fn((error: Error) => ({
        formatted: error.message,
      }));
      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        errorFormatter,
        transformRequest: () => {
          throw new Error("transform blew up");
        },
      });
      const interceptor = new InterceptorClass();
      let errorResponse: HttpErrorResponse | undefined;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Observable never settled")),
          2_000,
        );
        interceptor
          .intercept(new HttpRequest("GET", "/api/test"), { handle: vi.fn() })
          .subscribe({
            error: (error: HttpErrorResponse) => {
              clearTimeout(timeout);
              errorResponse = error;
              resolve();
            },
          });
      });

      expect(errorResponse).toBeInstanceOf(HttpErrorResponse);
      expect(errorResponse?.status).toBe(500);
      expect(errorResponse?.error).toEqual({ formatted: "transform blew up" });
      expect(mockInstance.handle).not.toHaveBeenCalled();
    });

    it("passes through when transformRequest rewrites to an unsupported method", async () => {
      mockInstance.handle = vi.fn();
      const realResponse = new HttpResponse({ body: "real" });
      const mockNext: HttpHandler = {
        handle: vi.fn().mockReturnValue(of(realResponse)),
      };
      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        transformRequest: () => ({ method: "PROPFIND" as any }),
      });
      const interceptor = new InterceptorClass();
      let emitted: HttpEvent<unknown> | undefined;

      await new Promise<void>((resolve) => {
        interceptor
          .intercept(new HttpRequest("GET", "/api/test"), mockNext)
          .subscribe({
            next: (event) => {
              emitted = event;
            },
            complete: resolve,
          });
      });

      expect(mockNext.handle).toHaveBeenCalledTimes(1);
      expect(mockInstance.handle).not.toHaveBeenCalled();
      expect(emitted).toBe(realResponse);
    });

    it("still tears down after an unsupported-method passthrough", () => {
      // The early return inside the Observable must return the teardown
      // function, not undefined, or unsubscribing leaks the inner sub.
      mockInstance.handle = vi.fn();
      const unsubscribe = vi.fn();
      const mockNext: HttpHandler = {
        handle: vi.fn().mockReturnValue({
          subscribe: () => ({ unsubscribe, closed: false }),
        }),
      } as unknown as HttpHandler;
      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        transformRequest: () => ({ method: "PROPFIND" as any }),
      });
      const interceptor = new InterceptorClass();

      const subscription = interceptor
        .intercept(new HttpRequest("GET", "/api/test"), mockNext)
        .subscribe();
      subscription.unsubscribe();

      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("formats an exception whose provenance a spreading transformResponse dropped", async () => {
      const marked = {
        status: 500,
        body: { error: "route blew up", code: "INTERNAL_ERROR" },
        headers: { "content-type": "application/json" },
      };
      Object.defineProperty(
        marked,
        Symbol.for("@schmock/core.response-origin"),
        {
          configurable: true,
          value: { kind: "exception", error: new Error("route blew up") },
        },
      );
      mockInstance.handle = vi.fn().mockResolvedValue(marked);
      const errorFormatter = vi.fn(() => ({ formatted: true }));
      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        errorFormatter,
        // An object spread copies only own enumerable properties, so the
        // non-enumerable provenance symbol is lost.
        transformResponse: (response) => ({
          ...response,
          headers: { ...response.headers, "x-mock": "true" },
        }),
      });
      const interceptor = new InterceptorClass();
      let errorResponse: HttpErrorResponse | undefined;

      await new Promise<void>((resolve) => {
        interceptor
          .intercept(new HttpRequest("GET", "/api/test"), { handle: vi.fn() })
          .subscribe({
            error: (error: HttpErrorResponse) => {
              errorResponse = error;
              resolve();
            },
          });
      });

      expect(errorFormatter).toHaveBeenCalledTimes(1);
      expect(errorResponse?.error).toEqual({ formatted: true });
    });

    it("runs transformRequest once per subscription", async () => {
      // Request derivation now lives inside the Observable, so it is
      // per-subscription rather than per-intercept. Pinned deliberately.
      mockInstance.handle = vi
        .fn()
        .mockResolvedValue({ status: 200, body: "ok", headers: {} });
      const transformRequest = vi.fn(() => ({}));
      const InterceptorClass = createSchmockInterceptor(mockInstance, {
        transformRequest,
      });
      const interceptor = new InterceptorClass();
      const result$ = interceptor.intercept(new HttpRequest("GET", "/api/t"), {
        handle: vi.fn(),
      });

      expect(transformRequest).not.toHaveBeenCalled();

      await new Promise<void>((resolve) =>
        result$.subscribe({ complete: resolve }),
      );
      await new Promise<void>((resolve) =>
        result$.subscribe({ complete: resolve }),
      );

      expect(transformRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe("provideSchmockInterceptor", () => {
    it("returns provider configuration", () => {
      const provider = provideSchmockInterceptor(mockInstance);

      expect(provider).toEqual({
        provide: HTTP_INTERCEPTORS,
        useFactory: expect.any(Function),
        multi: true,
      });
    });

    it("returns provider with options", () => {
      const provider = provideSchmockInterceptor(mockInstance, {
        baseUrl: "/api",
        passthrough: false,
      });

      expect(provider.provide).toBe(HTTP_INTERCEPTORS);
      expect(provider.useFactory).toBeDefined();
      expect(provider.multi).toBe(true);
    });

    // Regression: a runtime-generated @Injectable() class can't be AOT-compiled,
    // so `useClass` throws NG0204 ("needs JIT compiler") in apps without
    // @angular/compiler. The provider must use `useFactory` + manual `new`.
    it("uses useFactory (not useClass) so it works under AOT", () => {
      const provider = provideSchmockInterceptor(mockInstance);

      expect("useClass" in provider).toBe(false);
      const interceptor = provider.useFactory();
      expect(typeof interceptor.intercept).toBe("function");
    });
  });

  describe("request header combining", () => {
    async function capturedHeaders(
      headers: HttpHeaders,
    ): Promise<Record<string, string>> {
      mockInstance.handle = vi
        .fn()
        .mockResolvedValue({ status: 200, body: { ok: true }, headers: {} });
      const InterceptorClass = createSchmockInterceptor(mockInstance);
      const interceptor = new InterceptorClass();
      const request = new HttpRequest("GET", "/api/test", { headers });
      const next: HttpHandler = {
        handle: vi.fn().mockReturnValue(of(new HttpResponse({ body: "real" }))),
      };

      await new Promise<void>((resolve) => {
        interceptor.intercept(request, next).subscribe({
          next: () => resolve(),
          error: () => resolve(),
        });
      });

      const call = (mockInstance.handle as ReturnType<typeof vi.fn>).mock
        .calls[0];
      return call[2].headers as Record<string, string>;
    }

    it("combines a repeated header into one comma-joined field value", async () => {
      const headers = new HttpHeaders()
        .append("x-tag", "a")
        .append("x-tag", "b")
        .append("x-tag", "c");

      expect(await capturedHeaders(headers)).toEqual({ "x-tag": "a, b, c" });
    });

    it("leaves a single-valued header untouched", async () => {
      const headers = new HttpHeaders({ "x-single": "only" });

      expect(await capturedHeaders(headers)).toEqual({ "x-single": "only" });
    });

    it("omits a header whose value list is empty", async () => {
      // HttpHeaders keeps the key but reports an empty value list, so an
      // unguarded join would deliver an empty-string header.
      const headers = new HttpHeaders({ "x-empty": [], "x-kept": "yes" });

      expect(await capturedHeaders(headers)).toEqual({ "x-kept": "yes" });
    });
  });

  describe("status texts", () => {
    async function emitted(status: number): Promise<{
      response?: HttpResponse<unknown>;
      error?: HttpErrorResponse;
    }> {
      mockInstance.handle = vi
        .fn()
        .mockResolvedValue({ status, body: { any: true }, headers: {} });
      const InterceptorClass = createSchmockInterceptor(mockInstance);
      const interceptor = new InterceptorClass();
      const request = new HttpRequest("GET", "/api/test");
      const next: HttpHandler = {
        handle: vi.fn().mockReturnValue(of(new HttpResponse({ body: "real" }))),
      };

      return new Promise((resolve) => {
        interceptor.intercept(request, next).subscribe({
          next: (event: HttpEvent<unknown>) => {
            if (event instanceof HttpResponse) resolve({ response: event });
          },
          error: (error: unknown) =>
            resolve({ error: error as HttpErrorResponse }),
        });
      });
    }

    it.each([
      [202, "Accepted"],
      [206, "Partial Content"],
    ])("reports %i as %s on the success channel", async (status, text) => {
      const { response } = await emitted(status);
      expect(response?.statusText).toBe(text);
    });

    it.each([
      [307, "Temporary Redirect"],
      [402, "Payment Required"],
      [410, "Gone"],
      [415, "Unsupported Media Type"],
      [451, "Unavailable For Legal Reasons"],
      [501, "Not Implemented"],
      [504, "Gateway Timeout"],
    ])("reports %i as %s on the error channel", async (status, text) => {
      const { error } = await emitted(status);
      expect(error?.statusText).toBe(text);
    });

    it("falls back to OK for a non-registry 2xx status", async () => {
      const { response } = await emitted(299);
      expect(response?.statusText).toBe("OK");
    });

    it("falls back to Unknown Error for a non-registry error status", async () => {
      const { error } = await emitted(599);
      expect(error?.statusText).toBe("Unknown Error");
    });
  });
});
