---
name: plugin-authoring
description: >
  Create Schmock plugins following the Plugin interface. Use when implementing
  new plugins, extending the pipeline, or working with PluginContext.
argument-hint: "<plugin-name> <package>"
---

# Schmock Plugin Authoring Skill

## Plugin Interface

`packages/core/schmock.d.ts` is the source of truth. Read it before writing a
plugin. The shape at the time of writing:

```typescript
interface Plugin {
  name: string;           // Unique plugin identifier
  version?: string;       // Plugin version (semver)

  install?(instance: CallableMockInstance): void;
  uninstall?(instance: CallableMockInstance): void;
  beforeRequest?(context: PluginContext): PluginResult | void | Promise<PluginResult | void>;
  process(context: PluginContext, response?: unknown): PluginResult | Promise<PluginResult>;
  onError?(error: Error, context: PluginContext): Error | ResponseResult | void | Promise<Error | ResponseResult | void>;
}
```

- `install()` runs once when the plugin is piped. It must return synchronously;
  a Promise-returning install leaves the plugin inactive. Do not keep the
  scoped instance it receives.
- `uninstall()` runs during `reset()`, after every request admitted with the
  plugin has settled, in reverse registration order. It must be synchronous.
- `beforeRequest()` runs before the route generator. Returning a response
  short-circuits the generator; returning only a context passes request changes
  into it.
- `process()` runs after the generator and transforms its result.

## PluginContext

Available in `beforeRequest()`, `process()` and `onError()`:

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Request path |
| `route` | `RouteConfig` | Matched route configuration |
| `method` | `HttpMethod` | HTTP method |
| `params` | `Record<string, string>` | Route parameters (`:id` etc.) |
| `query` | `Record<string, string>` | Query string parameters |
| `headers` | `Record<string, string>` | Request headers |
| `body` | `unknown` (optional) | Request body |
| `state` | `Map<string, unknown>` | Shared state between plugins for this request |
| `requestShortCircuited` | `boolean` (optional) | `true` when a `beforeRequest` hook supplied the response |
| `routeState` | `Record<string, unknown>` (optional) | Route-specific state |
| `signal` | `AbortSignal` (optional, read-only) | Abort signal of the admitted request |

## PluginResult

```typescript
interface PluginResult {
  context: PluginContext;   // Updated context (can be modified)
  response?: unknown;       // Response data (if generated/modified)
}
```

## Pipeline Behavior

Plugins are global to the mock instance. `.pipe()` always attaches to the
instance, even when chained onto a route definition, so every plugin sees every
route. Each request runs in this order:

1. `beforeRequest` hooks, in `.pipe()` order. The first one that returns a
   response rejects the request before the route generator runs, so route side
   effects never happen.
2. The route generator, unless a `beforeRequest` hook short-circuited it.
3. `process` hooks, in `.pipe()` order. Each receives the generator's result
   (or the short-circuit response) and may transform it. A plugin that fills in
   missing data checks for an existing response first.

Guards such as auth or request validation belong in `beforeRequest`. A guard in
`process` runs after the generator, so it cannot stop route side effects.

```typescript
const mock = schmock({});

// Plugins apply to every route on the mock.
mock.pipe(authPlugin());    // beforeRequest: rejects unauthenticated requests
mock.pipe(cachePlugin());   // beforeRequest: serves cached responses
mock.pipe(logPlugin());     // process: logs and passes the response through

mock('GET /users', () => defaultData);
```

## Error Handling

`onError` is called when an error occurs during processing:

- **Return an `Error`** — replace the error (transformed error propagates)
- **Return `ResponseResult`** — suppress the error, use this as the response
- **Return `void`/`undefined`** — error propagates unchanged

## Reference Implementation: `fakerPlugin`

See `packages/faker/src/index.ts` for the canonical plugin pattern:

```typescript
export function fakerPlugin(options: FakerPluginOptions): Plugin {
  validateSchema(options.schema);

  return {
    name: "faker",
    version: packageVersion, // imported from the package's package.json

    async process(context: PluginContext, response?: unknown) {
      // Pass through if another plugin already generated a response
      if (response !== undefined && response !== null) {
        return { context, response };
      }

      // Generate response from schema
      const generatedResponse = await generateFromSchema({ ... });
      return { context, response: generatedResponse };
    }
  };
}
```

Key patterns:
- Factory function returns a `Plugin` object
- Validate options eagerly in the factory
- Check for existing response before generating — respect pipeline order
- Return `{ context, response }` always

## BDD Testing for Plugins

Every plugin should have BDD tests. Follow BDD-first development:

1. Write `.feature` scenarios describing plugin behavior
2. Write `.steps.ts` with step implementations
3. Implement the plugin to make tests pass

Example scenario structure:

```gherkin
Feature: Cache Plugin
  As a developer
  I want to cache API responses
  So that repeated requests are served faster

  Scenario: Cache hit returns cached response
    Given I create a mock with a cache plugin
    When I request "GET /users" twice
    Then the second response should be from cache
```

## Templates

Use `/plugin-authoring <name> <package>` to generate plugin boilerplate:

- `<name>.ts` — Plugin implementation
- `<name>.test.ts` — Unit tests
- `<name>.feature` — BDD feature file
- `<name>.steps.ts` — BDD step definitions

## Plugin Development Checklist

1. Define the plugin's purpose and behavior in a `.feature` file (BDD-first!)
2. Write step definitions
3. Implement the plugin factory function
4. Put request guards in `beforeRequest`, not `process`
5. Handle the "response already exists" case (pass-through or transform)
6. Implement `onError` if the plugin needs error handling
7. Add unit tests for complex internal logic
8. Run `bun test:all` to verify
