// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import {
  HTTP_INTERCEPTORS,
  HttpErrorResponse,
  type HttpEvent,
  type HttpHandler,
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
});
