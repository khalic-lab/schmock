# API Documentation

Complete API reference for the Schmock framework.

## Core API

### `schmock(config?)`

Creates a new callable Schmock mock instance.

```typescript
function schmock(config?: GlobalConfig): CallableMockInstance
```

**Parameters**:
- `config?: GlobalConfig` — Optional global configuration

```typescript
interface GlobalConfig {
  namespace?: string;                  // Base path prefix for all routes
  delay?: number | [number, number];   // Response delay in ms, or [min, max] range
  debug?: boolean;                     // Enable debug logging
  state?: Record<string, unknown>;     // Initial shared state object
}
```

**Returns**: `CallableMockInstance`

**Example**:
```typescript
import { schmock } from '@schmock/core';

const mock = schmock();

const mock = schmock({
  debug: true,
  namespace: '/api/v1',
  state: { users: [], posts: [] },
  delay: [100, 500]
});
```

### `CallableMockInstance`

The main interface for defining routes and handling requests. The instance itself is callable for route definition.

#### Route Definition (Callable)

```typescript
mock(route: RouteKey, generator: Generator, config?: RouteConfig): CallableMockInstance
```

**Parameters**:
- `route: RouteKey` — Route pattern in format `'METHOD /path'` (e.g., `'GET /users/:id'`)
- `generator: Generator` — Response generator (function, static data, or schema)
- `config?: RouteConfig` — Optional route-specific configuration

```typescript
interface RouteConfig {
  contentType?: string;   // MIME type (e.g., 'application/json', 'text/plain')
  [key: string]: any;     // Additional route-specific options
}
```

**Generator Types**:
- **Function**: `(context: RequestContext) => ResponseResult` — Called on each request
- **Static Data**: `any` — Returned as-is (detected when not a function)
- **JSON Schema**: `JSONSchema7` — Used with schema plugin for data generation

**Examples**:
```typescript
// Generator function
mock('GET /users', ({ state }) => state.users, {
  contentType: 'application/json'
})

// Static data
mock('GET /config', {
  version: '1.0.0',
  features: ['auth', 'api']
}, { contentType: 'application/json' })

// JSON Schema (with schema plugin)
mock('GET /users', {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      name: { type: 'string', faker: 'person.fullName' }
    }
  }
}, { contentType: 'application/json' })
```

#### `.pipe(plugin)`

Chain plugins using the pipeline:

```typescript
pipe(plugin: Plugin): CallableMockInstance
```

**Returns**: The same instance for method chaining.

**Example**:
```typescript
import { schemaPlugin } from '@schmock/schema'

mock('GET /users', userSchema, { contentType: 'application/json' })
  .pipe(schemaPlugin({ schema: userSchema }))
```

#### `.handle(method, path, options?)`

Handle a request and return a response.

```typescript
handle(method: HttpMethod, path: string, options?: RequestOptions): Promise<Response>
```

**Parameters**:
- `method: HttpMethod` — HTTP method
- `path: string` — Request path
- `options?: RequestOptions` — Request options

**Returns**: `Promise<Response>` — Always returns a response, never throws.

**Example**:
```typescript
const response = await mock.handle('GET', '/users/123', {
  headers: { 'Authorization': 'Bearer token' },
  query: { include: 'profile' }
});

console.log(response.status);  // 200
console.log(response.body);    // { id: 123, name: "John Doe", ... }
console.log(response.headers); // { "content-type": "application/json" }
```

## Types

### `HttpMethod`
```typescript
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD'
```

### `RouteKey`
```typescript
type RouteKey = `${HttpMethod} ${string}`
// e.g., 'GET /users', 'POST /users/:id'
```

### `Generator`
```typescript
type Generator = GeneratorFunction | StaticData | JSONSchema7
```

### `GeneratorFunction`
```typescript
type GeneratorFunction = (context: RequestContext) => ResponseResult | Promise<ResponseResult>
```

### `StaticData`
```typescript
type StaticData = string | number | boolean | null | undefined | Record<string, unknown> | unknown[]
```

### `RequestContext`

Context passed to generator functions:

```typescript
interface RequestContext {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;      // Route parameters (:id, :slug, etc.)
  query: Record<string, string>;       // Query string parameters
  headers: Record<string, string>;     // Request headers
  body?: unknown;                      // Request body (POST, PUT, PATCH)
  state: Record<string, unknown>;      // Shared mutable state
}
```

### `ResponseResult`

Generator functions can return any of these formats:

```typescript
type ResponseResult =
  | ResponseBody                                     // Direct value (200 OK)
  | [number, unknown]                                // [status, body]
  | [number, unknown, Record<string, string>]        // [status, body, headers]
```

### `RequestOptions`
```typescript
interface RequestOptions {
  headers?: Record<string, string>;
  body?: any;
  query?: Record<string, string>;
}
```

### `Response`
```typescript
interface Response {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}
```

## Plugin System

### `Plugin` Interface

```typescript
interface Plugin {
  name: string;
  version?: string;

  process(
    context: PluginContext,
    response?: unknown
  ): PluginResult | Promise<PluginResult>;

  onError?(
    error: Error,
    context: PluginContext
  ): Error | ResponseResult | void | Promise<Error | ResponseResult | void>;
}
```

### `PluginResult`
```typescript
interface PluginResult {
  context: PluginContext;
  response?: unknown;
}
```

### `PluginContext`
```typescript
interface PluginContext {
  path: string;
  route: RouteConfig;
  method: HttpMethod;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
  state: Map<string, unknown>;              // Shared state between plugins (per request)
  routeState?: Record<string, unknown>;     // Route-specific persistent state
}
```

### Plugin Pipeline Execution

Plugins execute in `.pipe()` order:

1. **First Plugin**: Receives context with no response
2. **Subsequent Plugins**: Receive context + response from previous plugin
3. **Response Generation**: First plugin to set response becomes the generator
4. **Response Transformation**: Later plugins can modify the response

### Writing Plugins

```typescript
// Logging plugin — passes through unchanged
function loggingPlugin(): Plugin {
  return {
    name: 'logging',
    version: '1.0.0',
    process(context, response) {
      console.log(`${context.method} ${context.path}`);
      return { context, response };
    }
  };
}

// Generator plugin — produces response if none exists
function staticDataPlugin(data: unknown): Plugin {
  return {
    name: 'static-data',
    process(context, response) {
      if (!response) {
        return { context, response: data };
      }
      return { context, response };
    }
  };
}

// Transformer plugin — modifies existing response
function headerPlugin(headers: Record<string, string>): Plugin {
  return {
    name: 'headers',
    process(context, response) {
      if (response && Array.isArray(response)) {
        const [status, body, existingHeaders = {}] = response;
        return {
          context,
          response: [status, body, { ...existingHeaders, ...headers }]
        };
      }
      return { context, response };
    }
  };
}

// Error handler plugin
function errorHandlerPlugin(): Plugin {
  return {
    name: 'error-handler',
    process(context, response) {
      return { context, response };
    },
    onError(error, context) {
      return {
        status: 500,
        body: { error: 'Internal server error', code: 'PLUGIN_ERROR' },
        headers: { 'Content-Type': 'application/json' }
      };
    }
  };
}
```

## Schema Plugin

### `schemaPlugin(options)`

Creates a schema plugin for JSON Schema-based data generation.

```typescript
function schemaPlugin(options: SchemaPluginOptions): Plugin
```

```typescript
interface SchemaPluginOptions {
  schema: JSONSchema7;
  count?: number;                       // Number of items for array schemas
  overrides?: Record<string, any>;      // Field overrides (supports templates)
}
```

**Example**:
```typescript
import { schemaPlugin } from '@schmock/schema';

const mock = schmock();

mock('GET /users', null, { contentType: 'application/json' })
  .pipe(schemaPlugin({
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string', faker: 'person.fullName' },
          email: { type: 'string', format: 'email' }
        }
      }
    },
    count: 5,
    overrides: { id: '{{params.id}}' }
  }))
```

### `generateFromSchema(options)`

Generate data from a JSON Schema directly (used internally by schema plugin).

```typescript
function generateFromSchema(options: SchemaGenerationContext): any
```

```typescript
interface SchemaGenerationContext {
  schema: JSONSchema7;
  count?: number;
  overrides?: Record<string, any>;
  params?: Record<string, string>;
  state?: any;
  query?: Record<string, string>;
}
```

### Template Syntax

Override values support templates that resolve from request context:

- `{{params.id}}` — Route parameters
- `{{state.user.name}}` — State values (supports nested access)
- `{{query.filter}}` — Query parameters

Single-template values preserve the original type. Mixed templates return strings.

## Express Adapter

### `toExpress(mock, options?)`

Convert a Schmock instance to Express middleware.

```typescript
function toExpress(mock: CallableMockInstance, options?: ExpressAdapterOptions): RequestHandler
```

```typescript
interface ExpressAdapterOptions {
  errorFormatter?: (error: Error, req: Request) => any;

  /** Pass non-Schmock errors to Express error handler. @default true */
  passErrorsToNext?: boolean;

  /** Custom header transformation from Express headers to Record<string, string> */
  transformHeaders?: (headers: Request['headers']) => Record<string, string>;

  /** Custom query transformation from Express query to Record<string, string> */
  transformQuery?: (query: Request['query']) => Record<string, string>;

  /** Request interceptor — modify request data before Schmock handles it */
  beforeRequest?: (req: Request, res: Response) =>
    | { method?: string; path?: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> }
    | undefined
    | Promise<any>;

  /** Response interceptor — modify response before sending to client */
  beforeResponse?: (
    schmockResponse: { status: number; body: any; headers: Record<string, string> },
    req: Request,
    res: Response,
  ) =>
    | { status: number; body: any; headers: Record<string, string> }
    | undefined
    | Promise<{ status: number; body: any; headers: Record<string, string> } | undefined>;
}
```

Routes not matched by Schmock automatically call `next()` to pass through to subsequent Express middleware.

**Example**:
```typescript
import express from 'express';
import { toExpress } from '@schmock/express';

const app = express();
const mock = schmock();

mock('GET /users', () => [{ id: 1, name: 'John' }], {
  contentType: 'application/json'
});

app.use('/api', toExpress(mock));
app.listen(3000);
```

**With options**:
```typescript
app.use('/api', toExpress(mock, {
  passErrorsToNext: false,
  beforeRequest: (req) => ({
    headers: { 'x-request-id': req.get('x-request-id') || 'none' }
  }),
  beforeResponse: (response) => ({
    ...response,
    headers: { ...response.headers, 'x-powered-by': 'schmock' }
  }),
  errorFormatter: (error) => ({
    message: error.message,
    timestamp: new Date().toISOString()
  })
}));
```

## Angular Adapter

### `createSchmockInterceptor(mock, options?)`

Create an Angular HTTP interceptor class from a Schmock instance.

```typescript
function createSchmockInterceptor(
  mock: CallableMockInstance,
  options?: AngularAdapterOptions
): new () => HttpInterceptor
```

```typescript
interface AngularAdapterOptions {
  /** Base URL to intercept (e.g., '/api'). If omitted, intercepts all requests. */
  baseUrl?: string;

  /** Pass through requests that don't match any route. @default true */
  passthrough?: boolean;

  /** Custom error formatter */
  errorFormatter?: (error: Error, request: HttpRequest<any>) => any;

  /** Modify request data before passing to Schmock */
  transformRequest?: (request: HttpRequest<any>) => {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: any;
    query?: Record<string, string>;
  };

  /** Modify Schmock response before returning to Angular */
  transformResponse?: (response: Schmock.Response, request: HttpRequest<any>) => Schmock.Response;
}
```

**Example**:
```typescript
import { createSchmockInterceptor } from '@schmock/angular';

const mock = schmock();
mock('GET /users', () => [{ id: 1, name: 'John' }], {
  contentType: 'application/json'
});

const InterceptorClass = createSchmockInterceptor(mock, {
  baseUrl: '/api',
  passthrough: false
});

// Register as provider
providers: [
  {
    provide: HTTP_INTERCEPTORS,
    useClass: InterceptorClass,
    multi: true
  }
]
```

### `provideSchmockInterceptor(mock, options?)`

Convenience function that returns a ready-to-use Angular provider configuration.

```typescript
function provideSchmockInterceptor(
  mock: CallableMockInstance,
  options?: AngularAdapterOptions
): { provide: InjectionToken; useClass: new () => HttpInterceptor; multi: true }
```

**Example**:
```typescript
import { provideSchmockInterceptor } from '@schmock/angular';

// In module providers or bootstrapApplication:
providers: [
  provideSchmockInterceptor(mock, { baseUrl: '/api' })
]
```

## Error Handling

### Error Hierarchy

All errors extend `SchmockError`:

```
SchmockError (base)
├── RouteNotFoundError
├── RouteParseError
├── RouteDefinitionError
├── ResponseGenerationError
├── PluginError
├── SchemaValidationError
├── SchemaGenerationError
└── ResourceLimitError
```

### `SchmockError`

Base class for all Schmock errors. Includes a machine-readable `code` and structured `context`.

```typescript
class SchmockError extends Error {
  readonly code: string;
  readonly context?: unknown;
  constructor(message: string, code: string, context?: unknown)
}
```

### `RouteNotFoundError`
```typescript
class RouteNotFoundError extends SchmockError {
  // code: "ROUTE_NOT_FOUND"
  // context: { method, path }
  constructor(method: string, path: string)
}
```

### `RouteParseError`
```typescript
class RouteParseError extends SchmockError {
  // code: "ROUTE_PARSE_ERROR"
  // context: { routeKey, reason }
  constructor(routeKey: string, reason: string)
}
```

### `RouteDefinitionError`
```typescript
class RouteDefinitionError extends SchmockError {
  // code: "ROUTE_DEFINITION_ERROR"
  // context: { routeKey, reason }
  constructor(routeKey: string, reason: string)
}
```

### `ResponseGenerationError`
```typescript
class ResponseGenerationError extends SchmockError {
  // code: "RESPONSE_GENERATION_ERROR"
  // context: { route, originalError }
  constructor(route: string, error: Error)
}
```

### `PluginError`
```typescript
class PluginError extends SchmockError {
  // code: "PLUGIN_ERROR"
  // context: { pluginName, originalError }
  constructor(pluginName: string, error: Error)
}
```

### `SchemaValidationError`
```typescript
class SchemaValidationError extends SchmockError {
  // code: "SCHEMA_VALIDATION_ERROR"
  // context: { schemaPath, issue, suggestion }
  constructor(schemaPath: string, issue: string, suggestion?: string)
}
```

### `SchemaGenerationError`
```typescript
class SchemaGenerationError extends SchmockError {
  // code: "SCHEMA_GENERATION_ERROR"
  // context: { route, originalError, schema }
  constructor(route: string, error: Error, schema?: unknown)
}
```

### `ResourceLimitError`
```typescript
class ResourceLimitError extends SchmockError {
  // code: "RESOURCE_LIMIT_ERROR"
  // context: { resource, limit, actual }
  constructor(resource: string, limit: number, actual?: number)
}
```

### Error Usage

```typescript
import {
  SchmockError,
  RouteNotFoundError,
  SchemaValidationError,
  ResourceLimitError
} from '@schmock/core';

const response = await mock.handle('GET', '/api/users');

// handle() never throws — check response status instead
if (response.status === 500) {
  console.log(response.body.code);  // e.g., "PLUGIN_ERROR"
}

// Schema plugin throws at creation time for invalid schemas
try {
  schemaPlugin({ schema: invalidSchema });
} catch (error) {
  if (error instanceof SchemaValidationError) {
    console.log(error.context); // { schemaPath: "$.properties.name", issue: "...", suggestion: "..." }
  }
}
```

## Constants

```typescript
import { HTTP_METHODS, ROUTE_NOT_FOUND_CODE, isHttpMethod, toHttpMethod } from '@schmock/core';

HTTP_METHODS          // readonly ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
ROUTE_NOT_FOUND_CODE  // 'ROUTE_NOT_FOUND'
isHttpMethod('GET')   // true (type guard: narrows to HttpMethod)
toHttpMethod('get')   // 'GET' (throws on invalid input)
```
