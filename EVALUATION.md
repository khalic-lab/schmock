# Repository Evaluation: schmock

## Overview
- The core package implements a callable mock API factory (`schmock`) that lets developers register routes and handle requests without a build step. The builder tracks routes, supports namespaces, auto-detects content types, applies optional delays, and runs a plugin pipeline for every request.
- An ecosystem of adapters and plugins supplements the core: an Express middleware adapter, an Angular HTTP interceptor, and a schema-driven data generator plugin built on `json-schema-faker` and `@faker-js/faker`.

## Findings
1. **Callable API and plugin pipeline**
   - `schmock` returns a function that registers routes and exposes `.handle()` and `.pipe()` for request handling and plugin registration, respectively.
   - Each request goes through namespace normalization, generator execution, and a plugin pipeline that can generate or transform responses before final parsing.

2. **Schema plugin capabilities**
   - The schema plugin validates JSON Schemas up front, generates data with `json-schema-faker`, enriches schemas with smart faker mappings, enforces resource limits, and supports override templates that reference params, query, or state values.

3. **Schema plugin state override bug**
   - When the core builds the plugin context it populates `context.state` with a `Map` and exposes the global mutable state under `context.routeState`. The schema plugin, however, forwards `context.state` into `generateFromSchema` where overrides and templates expect plain objects. Because Maps do not expose properties via dot-notation, overrides such as `"{{state.user.id}}"` cannot resolve when the plugin is used through `schmock.handle`, so state-driven templates fail.

## Testing
- Dependency installation via `bun install` fails with HTTP 403 responses from the npm registry in this environment, so third-party packages (e.g., `@faker-js/faker`, Angular, Vitest) cannot be fetched.
- Running `bun test` therefore fails: core unit tests execute, but schema and Angular suites error out because their dependencies are missing.

## Summary
The implementation largely matches the stated goal of a schema-driven mock API with a callable interface and plugin pipeline. The notable gap is that schema overrides referencing state do not work when the plugin is exercised through the callable mock because of the Map-vs-object mismatch in the plugin context. Restoring object semantics (or passing `routeState`) would unblock that advertised capability.
