// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpHandler,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import type { MockInstance } from "@schmock/builder";
import { Observable, of } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSchmockInterceptor, provideSchmockInterceptor } from "./index";

describe("Angular Adapter", () => {
  let mockInstance: MockInstance;

  beforeEach(() => {
    mockInstance = {
      handle: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
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
      expect(mockInstance.handle).toHaveBeenCalledWith("GET", "/api/test", {
        headers: {},
        body: null,
        query: {},
      });

      // Verify response
      expect(emittedValues).toHaveLength(1);
      const response = emittedValues[0] as HttpResponse<any>;
      expect(response.body).toEqual({ data: "mocked" });
      expect(response.status).toBe(200);
    });

    it("passes through when no route matches", async () => {
      mockInstance.handle = vi.fn().mockResolvedValue(null);

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
      mockInstance.handle = vi.fn().mockResolvedValue(null);

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
  });

  describe("provideSchmockInterceptor", () => {
    it("returns provider configuration", () => {
      const provider = provideSchmockInterceptor(mockInstance);

      expect(provider).toEqual({
        provide: "HTTP_INTERCEPTORS",
        useClass: expect.any(Function),
        multi: true,
      });
    });

    it("returns provider with options", () => {
      const provider = provideSchmockInterceptor(mockInstance, {
        baseUrl: "/api",
        passthrough: false,
      });

      expect(provider.provide).toBe("HTTP_INTERCEPTORS");
      expect(provider.useClass).toBeDefined();
      expect(provider.multi).toBe(true);
    });
  });
});
