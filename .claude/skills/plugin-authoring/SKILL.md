---
name: plugin-authoring
description: >
  Create Schmock plugins following the Plugin interface. Use when implementing
  new plugins, extending the pipeline, or working with PluginContext.
argument-hint: "<plugin-name> <package>"
---

# Schmock Plugin Authoring Skill

## Plugin Interface

Defined in `types/schmock.d.ts`:

```typescript
interface Plugin {
  name: string;           // Unique plugin identifier
  version?: string;       // Plugin version (semver)

  process(context: PluginContext, response?: any): PluginResult | Promise<PluginResult>;

  onError?(error: Error, context: PluginContext): Error | ResponseResult | void | Promise<Error | ResponseResult | void>;
}
```

## PluginContext

Available in `process()` and `onError()`:

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Request path |
| `route` | `RouteConfig` | Matched route configuration |
| `method` | `HttpMethod` | HTTP method |
| `params` | `Record<string, string>` | Route parameters (`:id` etc.) |
| `query` | `Record<string, string>` | Query string parameters |
| `headers` | `Record<string, string>` | Request headers |
| `body` | `unknown` | Request body |
| `state` | `Map<string, unknown>` | Shared state between plugins for this request |
| `routeState` | `Record<string, unknown>` | Route-specific state |

## PluginResult

```typescript
interface PluginResult {
  context: PluginContext;   // Updated context (can be modified)
  response?: unknown;       // Response data (if generated/modified)
}
```

## Pipeline Behavior

1. Plugins are called in order via `.pipe()`
2. **First plugin to set `response`** in its `PluginResult` is the generator
3. Subsequent plugins receive the response and can transform it
4. If no plugin sets a response, the route's generator function is used

```typescript
const mock = schmock({});
mock('GET /users', () => defaultData, {})
  .pipe(authPlugin())    // Can reject unauthenticated requests
  .pipe(cachePlugin())   // Can serve cached responses
  .pipe(logPlugin());    // Can log but pass through
```

## Error Handling

`onError` is called when an error occurs during processing:

- **Return an `Error`** — replace the error (transformed error propagates)
- **Return `ResponseResult`** — suppress the error, use this as the response
- **Return `void`/`undefined`** — error propagates unchanged

## Reference Implementation: `schemaPlugin`

See `packages/schema/src/index.ts` for the canonical plugin pattern:

```typescript
export function schemaPlugin(options: SchemaPluginOptions): Plugin {
  validateSchema(options.schema);

  return {
    name: "schema",
    version: "1.0.1",

    process(context: PluginContext, response?: any) {
      // Pass through if another plugin already generated a response
      if (response !== undefined && response !== null) {
        return { context, response };
      }

      // Generate response from schema
      const generatedResponse = generateFromSchema({ ... });
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
4. Handle the "response already exists" case (pass-through or transform)
5. Implement `onError` if the plugin needs error handling
6. Add unit tests for complex internal logic
7. Run `bun test:all` to verify
