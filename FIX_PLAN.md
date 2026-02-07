# Schmock Improvement Plan

Based on the comprehensive code review, this plan outlines the necessary refactoring and feature additions to address performance, concurrency, developer experience (DX), and safety.

## 1. High-Performance Routing (O(1) / O(k))

**Problem:** Current implementation uses `Array.find` (O(N)) which iterates twice per request.
**Goal:** Achieve O(1) for static routes and optimized lookups for parameterized routes.

### Strategy
1.  **Static Route Optimization:**
    *   Introduce `Map<string, CompiledCallableRoute>` for exact matches (`METHOD /path`).
    *   This instantly reduces lookup time for the majority of API calls to O(1).
2.  **Parameterized Route Optimization:**
    *   Keep the regex-based list but sort it by specificity (segment count) to ensure correct precedence without double iteration.
    *   (Future: Full Radix Tree if route count exceeds 1000s, but Map + List is the pragmatic "90/10" solution).

## 2. State Concurrency Safety

**Problem:** JavaScript's event loop allows race conditions in `async` handlers sharing state, as identified in `state-concurrency.feature`.
**Goal:** Provide a mechanism for atomic state updates.

### Strategy
1.  **Introduce `Mutex` Utility:**
    *   Implement a lightweight `AsyncMutex` class in `@schmock/core`.
    *   Export `createMutex` for users.
2.  **Usage Pattern:**
    ```typescript
    import { schmock, createMutex } from '@schmock/core';
    const lock = createMutex();
    
    mock('POST /increment', async ({ state }) => {
      await lock.run(() => {
        state.count++;
      });
      return { count: state.count };
    });
    ```

## 3. Adapter Debugging & Error Visibility

**Problem:** Adapters swallow errors and return generic 500s, hiding the root cause during development.
**Goal:** Improve error transparency in Express and Angular adapters.

### Strategy
1.  **Express Adapter:**
    *   Add `debug: boolean` to options.
    *   If `debug` is true, include stack trace and internal error details in the 500 response.
    *   Ensure `next(err)` is called correctly when `passErrorsToNext` is true.
2.  **Angular Adapter:**
    *   Add `logErrors: boolean` to options.
    *   Propagate original error details in the `HttpErrorResponse` error property when enabled.

## 4. Plugin Developer Experience

**Problem:** High boilerplate for plugins (checking `response` existence, handling contexts).
**Goal:** Simplify plugin authoring.

### Strategy
1.  **`createPlugin` Helper:**
    *   Abstract common patterns into a factory function.
    ```typescript
    export const myPlugin = createPlugin({
      name: 'my-plugin',
      // Auto-skips if response exists (configurable)
      transform: (ctx, response) => { ... },
      // Or pure generator
      generate: (ctx) => { ... }
    });
    ```

## Execution Order

1.  **Core Utilities:** Implement `AsyncMutex` and `createPlugin`.
2.  **Routing Refactor:** Update `CallableMockInstance` to use `Map` for static routes.
3.  **Adapter Updates:** Modify `@schmock/express` and `@schmock/angular`.
4.  **Verification:** Run the BDD suite to ensure no regressions.
