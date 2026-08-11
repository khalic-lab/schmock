---
name: plugin-authoring
description: Design, implement, or update type-safe Schmock pipeline plugins and their unit or BDD tests. Use for work involving Schmock.Plugin, PluginContext, install hooks, process pipelines, or onError recovery.
---

# Author a Schmock plugin

Treat these live files as authoritative before implementing a plugin:

- `packages/core/schmock.d.ts` for `Plugin`, `PluginContext`, and result types
- `packages/core/src/plugin-pipeline.ts` for runtime pipeline and error behavior
- `packages/faker/src/index.ts` and other current package plugins for implementation conventions

## Current contract

- Return a factory-created `Plugin` object with a unique `name`.
- Read the plugin version from its package JSON rather than hard-coding it.
- Use `install(instance)` only for one-time setup performed when `.pipe()` registers the plugin.
- Implement `process(context, response?: unknown)` and always return a valid `{ context, response? }` result, synchronously or asynchronously.
- Treat `PluginContext.state` as per-request state shared across plugins. Treat optional `routeState` as route/global state supplied by the core builder.
- Preserve an existing response unless the plugin intentionally transforms it. A generator-style plugin may create a response when the incoming value is `undefined` or `null`.
- Add `onError` only when the plugin must transform or recover from errors. Runtime recovery recognizes a status tuple or an object with `status`; returning an `Error` transforms the failure, while no result propagates the original failure.

The route generator runs before the plugin pipeline in the current builder, so most plugins receive an existing response. Later plugins can transform a response returned by an earlier stage.

## Workflow

1. Describe observable behavior in a root `features/*.feature` file when adding or changing a public contract.
2. Place step definitions under the package's `src/steps/` directory and add focused unit tests for internal branches.
3. Start from the templates in this skill only after inspecting the destination package's exports and file layout:
   - `templates/plugin.ts.tmpl`
   - `templates/plugin.test.ts.tmpl`
   - `templates/plugin.feature.tmpl`
   - `templates/plugin.steps.ts.tmpl`
4. Replace every `{{PLACEHOLDER}}`; do not leave template markers in source.
5. Replace the templates' observable `processedBy` example with the plugin's intended domain behavior and keep the feature, step, and unit assertions behavior-specific.
6. Add an options type and factory parameter only when the plugin actually accepts configuration.
7. Keep request and response values typed as `unknown` until narrowed. Do not use `any` assertions to make a template compile.
8. Run the destination package's typecheck and focused tests, then the repository checks appropriate to the change.

Prefer the exported `@schmock/core` types and helpers such as `toHttpMethod` over local duplicate types or unchecked casts.
