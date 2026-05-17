// JIT compiler must be loaded before any Angular DI runtime imports.
import "@angular/compiler";
import { HttpRequest, HttpResponse, type HttpEvent, type HttpHandler } from "@angular/common/http";
import { schmock } from "@schmock/core";
import { createSchmockInterceptor } from "@schmock/angular";
import { Observable, lastValueFrom, of } from "rxjs";

// 1. Verify export shape
if (typeof createSchmockInterceptor !== "function")
  throw new Error("createSchmockInterceptor not a function");

// 2. Build a mock and an interceptor class
const mock = schmock();
mock("GET /users", [{ id: 1, name: "Alice" }]);

const InterceptorClass = createSchmockInterceptor(mock);
const interceptor = new InterceptorClass();

// 3. A passthrough HttpHandler that returns an empty 200 — we should never
//    see it called for routes our mock handles.
let passthroughCalled = false;
const passthrough: HttpHandler = {
  handle(): Observable<HttpEvent<unknown>> {
    passthroughCalled = true;
    return of(new HttpResponse({ status: 200, body: null }));
  },
};

// 4. Matched route -> mock response, passthrough not called
const matchedReq = new HttpRequest("GET", "http://localhost/users");
const matchedRes = (await lastValueFrom(
  interceptor.intercept(matchedReq, passthrough),
)) as HttpResponse<unknown>;

if (matchedRes.status !== 200)
  throw new Error("Matched status: " + matchedRes.status);
const body = matchedRes.body as Array<{ id: number; name: string }>;
if (!Array.isArray(body) || body[0]?.name !== "Alice")
  throw new Error("Matched body: " + JSON.stringify(body));
if (passthroughCalled)
  throw new Error("Passthrough should not fire for matched route");

// 5. Unmatched route -> passthrough fires
const unmatchedReq = new HttpRequest("GET", "http://localhost/posts");
await lastValueFrom(interceptor.intercept(unmatchedReq, passthrough));
if (!passthroughCalled)
  throw new Error("Passthrough should fire for unmatched route");

console.log("@schmock/angular: all checks passed");
