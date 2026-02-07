# Coding Standards

Standards extracted from the Schmock codebase. All contributors and AI assistants must follow these conventions.

## TypeScript

### Strict Mode

TypeScript strict mode is enabled project-wide. Never use `// @ts-ignore` or `// @ts-expect-error` to suppress errors — fix the root cause.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "strict": true,
    "moduleResolution": "bundler"
  }
}
```

### Type System

**Ambient types** live in `/types/schmock.d.ts` and are the single source of truth. Packages re-export them via `types.ts`:

```typescript
/// <reference path="../../../types/schmock.d.ts" />
export type HttpMethod = Schmock.HttpMethod;
export type RouteKey = Schmock.RouteKey;
```

**Prefer type narrowing over casting.** Use type guards to narrow types at runtime:

```typescript
// Good — runtime validation narrows the type
export function isHttpMethod(method: string): method is HttpMethod {
  return HTTP_METHODS.includes(method as HttpMethod);
}

export function toHttpMethod(method: string): HttpMethod {
  const upper = method.toUpperCase();
  if (!isHttpMethod(upper)) {
    throw new Error(`Invalid HTTP method: "${method}"`);
  }
  return upper;
}

// Avoid — blind cast
const method = value as HttpMethod;
```

**Use `as const` for literal arrays and objects:**

```typescript
export const HTTP_METHODS: readonly HttpMethod[] = [
  "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
] as const;
```

**Use template literal types for structured strings:**

```typescript
type RouteKey = `${HttpMethod} ${string}`;
```

**Use union types for flexible APIs:**

```typescript
type ResponseResult =
  | ResponseBody
  | [number, unknown]                         // [status, body]
  | [number, unknown, Record<string, string>]; // [status, body, headers]
```

**Use parameter objects instead of long parameter lists:**

```typescript
// Good
interface SchemaGenerationContext {
  schema: JSONSchema7;
  count?: number;
  overrides?: Record<string, any>;
  params?: Record<string, string>;
}

function generateFromSchema(options: SchemaGenerationContext): any

// Avoid
function generateFromSchema(
  schema: JSONSchema7, count?: number,
  overrides?: Record<string, any>, params?: Record<string, string>
): any
```

### Imports

Separate type imports from value imports. Group by origin:

```typescript
// 1. Type-only imports (external)
import type { HttpEvent, HttpHandler, HttpInterceptor } from "@angular/common/http";

// 2. Value imports (external)
import { HTTP_INTERCEPTORS, HttpErrorResponse } from "@angular/common/http";
import { Injectable } from "@angular/core";

// 3. Internal imports
import type { CallableMockInstance } from "@schmock/core";
import { ROUTE_NOT_FOUND_CODE, SchmockError } from "@schmock/core";

// 4. Relative imports
import { parseRouteKey } from "./parser";
import { PluginError, RouteNotFoundError } from "./errors";
```

Biome enforces import organization automatically via `organizeImports: "on"`.

## Naming

| Category | Convention | Examples |
|---|---|---|
| Types / Interfaces | PascalCase | `PluginContext`, `ResponseResult` |
| Type aliases | PascalCase | `RouteKey`, `HttpMethod` |
| Variables / Parameters | camelCase | `globalConfig`, `matchedRoute` |
| Constants | UPPER_SNAKE_CASE | `ROUTE_NOT_FOUND_CODE`, `HTTP_METHODS` |
| Functions | camelCase | `parseRouteKey()`, `extractParams()` |
| Error classes | PascalCase + `Error` | `RouteNotFoundError`, `PluginError` |
| Files | kebab-case or dot-separated | `builder.ts`, `parser.property.test.ts` |
| Test files | `*.test.ts` | `index.test.ts`, `errors.test.ts` |
| Step definitions | `*.steps.ts` | `fluent-api.steps.ts` |
| BDD features | kebab-case `.feature` | `fluent-api.feature`, `error-handling.feature` |

## Functions

### Pure Functions

Prefer pure functions — no side effects, deterministic output. Thread state explicitly:

```typescript
// Good — pure, tracks path via parameter
function validateSchema(schema: JSONSchema7, path = "$"): void {
  if (schema.type === "object" && schema.properties) {
    for (const [name, prop] of Object.entries(schema.properties)) {
      validateSchema(prop as JSONSchema7, `${path}.properties.${name}`);
    }
  }
}

// Good — graph traversal with explicit state
function hasCircularReference(schema: JSONSchema7, visited = new Set()): boolean {
  if (visited.has(schema)) return true;
  visited.add(schema);
  // ... traverse children
  visited.delete(schema); // backtrack
  return false;
}
```

### Early Returns

Exit early for guard conditions. Avoid deep nesting:

```typescript
// Good
private async applyDelay(): Promise<void> {
  if (!this.globalConfig.delay) return;

  const delay = Array.isArray(this.globalConfig.delay)
    ? Math.random() * (this.globalConfig.delay[1] - this.globalConfig.delay[0]) + this.globalConfig.delay[0]
    : this.globalConfig.delay;

  await new Promise((resolve) => setTimeout(resolve, delay));
}
```

### Immutability

Create copies instead of mutating inputs:

```typescript
// Good — shallow copy, then modify
function enhanceFieldSchema(fieldName: string, fieldSchema: JSONSchema7): JSONSchema7 {
  const enhanced = { ...fieldSchema };
  // modify enhanced, not fieldSchema
  return enhanced;
}

// Good — deep clone before mutation
function applyOverrides(data: any, overrides?: Record<string, any>): any {
  if (!overrides) return data;
  const result = JSON.parse(JSON.stringify(data));
  // modify result
  return result;
}
```

### Defaults and Fallbacks

Use a clear priority chain — explicit value > constraints > default constant:

```typescript
function determineArrayCount(schema: JSONSchema7, explicitCount?: number): number {
  if (explicitCount !== undefined) return Math.max(0, explicitCount);
  if (schema.minItems !== undefined && schema.maxItems !== undefined) {
    return Math.floor(Math.random() * (schema.maxItems - schema.minItems + 1)) + schema.minItems;
  }
  return DEFAULT_ARRAY_COUNT;
}
```

### Destructuring with Inline Defaults

```typescript
const {
  errorFormatter,
  passErrorsToNext = true,
  transformHeaders = defaultTransformHeaders,
  beforeRequest,
} = options;
```

## Error Handling

### Error Hierarchy

All errors extend `SchmockError` with a machine-readable `code` and structured `context`:

```typescript
export class SchmockError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: unknown,
  ) {
    super(message);
    this.name = "SchmockError";
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
```

Domain-specific errors carry relevant context:

```typescript
export class SchemaValidationError extends SchmockError {
  constructor(schemaPath: string, issue: string, suggestion?: string) {
    super(
      `Schema validation failed at ${schemaPath}: ${issue}${suggestion ? `. ${suggestion}` : ""}`,
      "SCHEMA_VALIDATION_ERROR",
      { schemaPath, issue, suggestion },
    );
    this.name = "SchemaValidationError";
  }
}
```

### Never Throw from Public APIs

Public-facing methods like `handle()` catch errors and return a response:

```typescript
async handle(method, path, options?): Promise<Response> {
  try {
    // ... process request
  } catch (error) {
    return {
      status: 500,
      body: {
        error: (error as Error).message,
        code: error instanceof SchmockError ? error.code : "INTERNAL_ERROR",
      },
      headers: {},
    };
  }
}
```

### Preserve Specific Errors, Wrap Generic Ones

```typescript
try {
  return generateFromSchema({ schema });
} catch (error) {
  if (error instanceof SchemaValidationError || error instanceof ResourceLimitError) {
    throw error; // re-throw domain errors as-is
  }
  throw new SchemaGenerationError(
    context.path,
    error instanceof Error ? error : new Error(String(error)),
    schema,
  );
}
```

### Fail Fast

Validate at configuration time, not at request time:

```typescript
export function schemaPlugin(options: SchemaPluginOptions): Plugin {
  validateSchema(options.schema); // throws immediately if invalid
  return { /* plugin */ };
}
```

## Constants

Name all magic numbers and strings. Centralize limits:

```typescript
const MAX_ARRAY_SIZE = 10000;
const MAX_NESTING_DEPTH = 10;
const DEFAULT_ARRAY_COUNT = 3;
export const ROUTE_NOT_FOUND_CODE = "ROUTE_NOT_FOUND" as const;
```

## Code Organization

### Package Structure

Each package follows:

```
packages/<name>/
├── src/
│   ├── index.ts          # Public API, exports
│   ├── types.ts           # Type re-exports (if needed)
│   ├── <module>.ts        # Implementation modules
│   ├── errors.ts          # Custom errors (if needed)
│   ├── constants.ts       # Constants (if needed)
│   ├── *.test.ts          # Unit tests
│   └── steps/
│       └── *.steps.ts     # BDD step definitions
├── tsconfig.json
└── package.json
```

### Module Boundaries

- `index.ts` is the public API — re-exports only what consumers need
- Group exports by category: constants, errors, types
- Internal helpers stay in their module, never exported from `index.ts`

```typescript
// index.ts — organized re-exports
export { HTTP_METHODS, isHttpMethod, ROUTE_NOT_FOUND_CODE } from "./constants";
export { PluginError, RouteNotFoundError, SchemaValidationError } from "./errors";
export type { CallableMockInstance, Generator, HttpMethod } from "./types";
```

### Single Responsibility

One concern per file:

- `builder.ts` — route management and request handling
- `parser.ts` — route key parsing only
- `errors.ts` — error definitions only
- `constants.ts` — constants and type guards

## Patterns

### Factory Functions

Prefer factory functions over classes for public APIs:

```typescript
// Express — returns middleware
export function toExpress(mock: CallableMockInstance, options = {}): RequestHandler {
  return async (req, res, next) => { /* ... */ };
}

// Angular — returns class constructor for DI
export function createSchmockInterceptor(mock, options = {}): new () => HttpInterceptor {
  @Injectable()
  class SchmockInterceptor implements HttpInterceptor { /* ... */ }
  return SchmockInterceptor;
}
```

### Plugin Interface

Plugins implement `process()` and optionally `onError()`:

```typescript
interface Plugin {
  name: string;
  version?: string;
  process(context: PluginContext, response?: any): PluginResult | Promise<PluginResult>;
  onError?(error: Error, context: PluginContext): Error | ResponseResult | void;
}
```

Design plugins to be pipeline-aware — pass through response if none exists, transform if one does:

```typescript
process(context, response) {
  if (response) {
    return { context, response: transform(response) };
  }
  return { context, response };
}
```

### Lazy Initialization

Defer expensive setup until first use:

```typescript
let jsfConfigured = false;

function getJsf() {
  if (!jsfConfigured) {
    jsf.extend("faker", () => createFakerInstance());
    jsf.option({ requiredOnly: false, alwaysFakeOptionals: true });
    jsfConfigured = true;
  }
  return jsf;
}
```

## Comments

### What to Comment

Comment the **why**, never the **what**. The code should be self-explanatory:

```typescript
// Good — explains a design decision
// Two-pass matching: static routes first for performance, then parameterized
private findRoute(method: HttpMethod, path: string): CompiledCallableRoute | undefined {

// Good — explains non-obvious behavior
// Even error responses get delayed to simulate realistic latency
await this.applyDelay();
```

### JSDoc

Use JSDoc on public APIs with `@example` blocks:

```typescript
/**
 * Create a new Schmock mock instance with callable API.
 *
 * @example
 * ```typescript
 * const mock = schmock({ debug: true })
 * mock('GET /users', () => [{ id: 1, name: 'John' }])
 * const response = await mock.handle('GET', '/users')
 * ```
 *
 * @param config Optional global configuration
 * @returns A callable mock instance
 */
export function schmock(config?: GlobalConfig): CallableMockInstance
```

No JSDoc on internal/private methods unless the logic is non-obvious.

## Testing

### Test Layers

| Layer | Tool | Location | Purpose |
|---|---|---|---|
| BDD | vitest-cucumber | `features/*.feature` + `packages/*/src/steps/*.steps.ts` | Behavior specification |
| Unit | Vitest | `packages/*/src/*.test.ts` | Implementation correctness |
| Property | fast-check | `packages/*/src/*.property.test.ts` | Edge cases, fuzzing |

### BDD Feature Files

Follow the Gherkin pattern — user story + design notes + scenarios:

```gherkin
Feature: Callable API
  As a developer
  I want to define mocks using a direct callable API
  So that I can create readable and maintainable mocks

  # Design Decision: callable factory function pattern
  # - Direct and minimal boilerplate
  # - No need for build() calls

  Scenario: Simple route with generator function
    Given I create a mock with:
      """
      const mock = schmock({})
      mock('GET /users', () => [{ id: 1, name: 'John' }], { contentType: 'application/json' })
      """
    When I request "GET /users"
    Then I should receive:
      """
      [{ "id": 1, "name": "John" }]
      """
```

### Unit Test Organization

Three-level `describe` hierarchy — feature, category, specific test:

```typescript
describe("Schema Generator", () => {
  describe("Core Functionality", () => {
    it("generates data from simple schemas", () => { /* ... */ });
    it("generates arrays with specified count", () => { /* ... */ });
  });

  describe("Schema Validation", () => {
    describe("invalid schemas", () => {
      it("rejects empty schema objects", () => { /* ... */ });
    });
  });
});
```

Test names read as specifications — describe **what** the code does, not **how**:

```typescript
// Good
it("rejects empty schema objects", () => { /* ... */ });
it("enforces array size limits", () => { /* ... */ });

// Avoid
it("should throw when schema is empty", () => { /* ... */ });
it("test array size", () => { /* ... */ });
```

### Test Helpers

Use factory functions and semantic assertion helpers:

```typescript
// Factories for test data
export const schemas = {
  simple: {
    object: (properties = {}): JSONSchema7 => ({ type: "object", properties }),
    array: (items: JSONSchema7): JSONSchema7 => ({ type: "array", items }),
  },
};

// Semantic assertions
export const schemaTests = {
  expectValid: (schema: JSONSchema7): void => {
    expect(() => generateFromSchema({ schema })).not.toThrow();
  },
  expectSchemaError: (schema: any, path: string): void => {
    // validates error type, path, and message
  },
};
```

### Mocking Pattern

Use `vi.fn()` with partial interfaces and `as unknown as Type`:

```typescript
function createMock(handleFn: (...args: any[]) => any): CallableMockInstance {
  return { handle: vi.fn(handleFn), pipe: vi.fn() } as any;
}

function createRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    send: vi.fn(),
    end: vi.fn(),
  } as unknown as Response;
}
```

### Property-Based Tests

Use `fast-check` for fuzz testing parsers and validators:

```typescript
it("never throws an unhandled error on arbitrary input", () => {
  fc.assert(
    fc.property(arbitraryString, (input) => {
      try {
        parseRouteKey(input);
      } catch (e) {
        expect(e).toBeInstanceOf(RouteParseError);
      }
    }),
    { numRuns: 1000 },
  );
});
```

## Linting

Biome enforces these rules (see `biome.json`):

| Rule | Level | Rationale |
|---|---|---|
| `noParameterAssign` | error | Enforce immutability of function parameters |
| `useAsConstAssertion` | error | Prefer `as const` for literals |
| `useDefaultParameterLast` | error | Default params at end of signature |
| `noUnusedTemplateLiteral` | error | Use plain strings when no interpolation |
| `useNumberNamespace` | error | Use `Number.parseInt` over `parseInt` |
| `noInferrableTypes` | warn | Don't annotate types TS can infer |
| `noUselessElse` | warn | Use early returns over else blocks |
| `noUnusedFunctionParameters` | warn | Remove unused parameters |
| `noExplicitAny` | off | `any` is allowed where type safety isn't practical |

Formatting: spaces (not tabs), auto-format on save.

## Git

- **Branch flow**: `feature/*` -> `develop` -> `main`
- **Commits**: conventional commit format, no Claude signatures
- **Pre-commit hooks**: lint + full test suite (`bun run setup` to configure)
- **Quiet commands**: `bun lint:quiet`, `bun test:quiet`, `bun build:quiet`
