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
import { fakerPlugin } from '@schmock/faker'

mock('GET /users', userSchema, { contentType: 'application/json' })
  .pipe(fakerPlugin({ schema: userSchema }))
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

#### `.history(method?, path?)`

Get recorded request history, optionally filtered by method and path.

```typescript
history(method?: HttpMethod, path?: string): RequestRecord[]
```

**Parameters**:
- `method?: HttpMethod` — Filter by HTTP method
- `path?: string` — Filter by path (exact match)

**Returns**: Array of `RequestRecord` objects.

**Example**:
```typescript
await mock.handle('GET', '/users');
await mock.handle('POST', '/users', { body: { name: 'John' } });

const allRequests = mock.history();           // All requests
const getRequests = mock.history('GET');      // Only GET requests
const userPosts = mock.history('POST', '/users');  // POST /users only
```

#### `.called(method?, path?)`

Check if any matching requests were recorded. Returns boolean.

```typescript
called(method?: HttpMethod, path?: string): boolean
```

**Example**:
```typescript
mock.called('GET', '/users');     // true if GET /users was called
mock.called('POST');              // true if any POST request was made
mock.called();                    // true if any request was made
```

#### `.callCount(method?, path?)`

Get the count of matching recorded requests.

```typescript
callCount(method?: HttpMethod, path?: string): number
```

**Example**:
```typescript
mock.callCount('GET', '/users');  // Number of GET /users requests
mock.callCount('DELETE');         // Number of DELETE requests
mock.callCount();                 // Total request count
```

#### `.lastRequest(method?, path?)`

Get the most recent matching request record.

```typescript
lastRequest(method?: HttpMethod, path?: string): RequestRecord | undefined
```

**Returns**: Most recent `RequestRecord` or `undefined` if no match.

**Example**:
```typescript
const last = mock.lastRequest('POST', '/users');
console.log(last?.body);  // { name: 'John' }
```

#### `.listen(port?, hostname?)`

Start the mock as a standalone HTTP server.

```typescript
listen(port?: number, hostname?: string): Promise<ServerInfo>
```

**Parameters**:
- `port?: number` — Port to listen on (default: `0` for random available port)
- `hostname?: string` — Hostname to bind to (default: `'127.0.0.1'`)

**Returns**: `Promise<ServerInfo>` — Resolves with the actual port and hostname once the server is listening.

**Throws**: `SchmockError` with code `SERVER_ALREADY_RUNNING` if the server is already listening.

**Example**:
```typescript
const mock = schmock();
mock('GET /users', [{ id: 1, name: 'Alice' }]);

const info = await mock.listen(3000);
console.log(`Server running on http://${info.hostname}:${info.port}`);

// Use port 0 for a random available port (useful in tests)
const info = await mock.listen(0);
const res = await fetch(`http://127.0.0.1:${info.port}/users`);
```

#### `.close()`

Stop the standalone HTTP server. Idempotent — safe to call even if the server is not running.

```typescript
close(): void
```

**Example**:
```typescript
const info = await mock.listen(0);
// ... use the server ...
mock.close();  // Stop listening
mock.close();  // No-op, safe to call again
```

#### `.reset()`

Clear all routes, state, and history. Also stops the server if running.

```typescript
reset(): void
```

**Example**:
```typescript
mock.reset();  // Full reset — removes all routes, clears state, history, and stops server
```

#### `.resetHistory()`

Clear only request history.

```typescript
resetHistory(): void
```

**Example**:
```typescript
mock.resetHistory();  // Clear history but keep routes and state
```

#### `.resetState()`

Clear only state, keep routes and history.

```typescript
resetState(): void
```

**Example**:
```typescript
mock.resetState();  // Reset state to initial config, keep routes and history
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

### `ServerInfo`
```typescript
interface ServerInfo {
  port: number;
  hostname: string;
}
```

## Plugin System

### `Plugin` Interface

```typescript
interface Plugin {
  name: string;
  version?: string;

  install?(instance: CallableMockInstance): void;  // Register routes at pipe() time

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

### `fakerPlugin(options)`

Creates a schema plugin for JSON Schema-based data generation.

```typescript
function fakerPlugin(options: FakerPluginOptions): Plugin
```

```typescript
interface FakerPluginOptions {
  schema: JSONSchema7;
  count?: number;                       // Number of items for array schemas
  overrides?: Record<string, any>;      // Field overrides (supports templates)
}
```

**Example**:
```typescript
import { fakerPlugin } from '@schmock/faker';

const mock = schmock();

mock('GET /users', null, { contentType: 'application/json' })
  .pipe(fakerPlugin({
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

## Validation Plugin

### `validationPlugin(options)`

Creates a validation plugin for JSON Schema-based request and response validation using AJV.

```typescript
function validationPlugin(options: ValidationPluginOptions): Plugin
```

```typescript
interface ValidationPluginOptions {
  requestBody?: JSONSchema7;      // Validate request body
  requestQuery?: JSONSchema7;     // Validate query parameters
  requestHeaders?: JSONSchema7;   // Validate request headers
  responseBody?: JSONSchema7;     // Validate response body
}
```

**Behavior**:
- Returns `400 Bad Request` for invalid request data
- Returns `500 Internal Server Error` for invalid response data
- Validation errors include detailed AJV error messages

**Example**:
```typescript
import { validationPlugin } from '@schmock/validation';

const mock = schmock();

mock('POST /users', ({ body, state }) => {
  state.users.push(body);
  return [201, body];
}, { contentType: 'application/json' })
  .pipe(validationPlugin({
    requestBody: {
      type: 'object',
      required: ['name', 'email'],
      properties: {
        name: { type: 'string', minLength: 1 },
        email: { type: 'string', format: 'email' }
      }
    },
    responseBody: {
      type: 'object',
      required: ['id', 'name', 'email'],
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        email: { type: 'string' }
      }
    }
  }));

// Valid request
await mock.handle('POST', '/users', {
  body: { name: 'John', email: 'john@example.com' }
}); // 201

// Invalid request
await mock.handle('POST', '/users', {
  body: { name: 'John' }  // Missing email
}); // 400 with validation errors
```

## Query Plugin

### `queryPlugin(options?)`

Creates a query plugin that adds pagination, sorting, and filtering capabilities to array responses.

```typescript
function queryPlugin(options?: QueryPluginOptions): Plugin
```

```typescript
interface QueryPluginOptions {
  pagination?: boolean;     // Enable pagination (?page=1&limit=10) — default: true
  sorting?: boolean;        // Enable sorting (?sort=name) — default: true
  filtering?: boolean;      // Enable filtering (?filter[role]=admin) — default: true
  defaultLimit?: number;    // Default items per page — default: 10
  maxLimit?: number;        // Maximum items per page — default: 100
}
```

**Query Parameters**:
- Pagination: `?page=1&limit=10`
- Sorting: `?sort=name` or `?sort=-name` (descending)
- Filtering: `?filter[field]=value` (exact match)

**Example**:
```typescript
import { queryPlugin } from '@schmock/query';

const mock = schmock({
  state: {
    users: [
      { id: 1, name: 'Alice', role: 'admin' },
      { id: 2, name: 'Bob', role: 'user' },
      { id: 3, name: 'Charlie', role: 'user' },
      { id: 4, name: 'Diana', role: 'admin' }
    ]
  }
});

mock('GET /users', ({ state }) => state.users, {
  contentType: 'application/json'
})
  .pipe(queryPlugin({
    pagination: true,
    sorting: true,
    filtering: true,
    defaultLimit: 2,
    maxLimit: 50
  }));

// Pagination
await mock.handle('GET', '/users?page=1&limit=2');
// Returns first 2 users

// Sorting
await mock.handle('GET', '/users?sort=name');
// Returns users sorted by name ascending

await mock.handle('GET', '/users?sort=-name');
// Returns users sorted by name descending

// Filtering
await mock.handle('GET', '/users?filter[role]=admin');
// Returns only admin users

// Combined
await mock.handle('GET', '/users?filter[role]=user&sort=name&page=1&limit=2');
// Returns first 2 users with role=user, sorted by name
```

## OpenAPI Plugin

### `openapi(options)`

Creates an OpenAPI plugin that automatically registers routes from an OpenAPI/Swagger specification.

```typescript
async function openapi(options: OpenApiOptions): Promise<Plugin>
```

**Note**: This is an async factory function that returns a Promise resolving to a Plugin with an `install()` hook.

```typescript
interface OpenApiOptions {
  spec: string | object;    // File path to spec or inline spec object
  seed?: SeedConfig;        // Optional seed data for CRUD resources
}

type SeedConfig = {
  [resourceName: string]: unknown[] | string | { count: number }
};
```

**Seed Configuration**:
- `unknown[]` — Inline array of seed data
- `string` — File path to JSON file containing seed data
- `{ count: number }` — Auto-generate N items using schema

**Features**:
- Supports Swagger 2.0, OpenAPI 3.0, and OpenAPI 3.1
- Auto-detects CRUD resources from path patterns (e.g., `/users`, `/users/{id}`)
- Registers CRUD routes with in-memory stateful collections
- Non-CRUD endpoints get schema-generated static responses
- Handles discriminators, circular references, and complex schemas
- Supports polymorphic responses (oneOf, anyOf, allOf)

**Example**:
```typescript
import { openapi } from '@schmock/openapi';

const mock = schmock();

// Load from file with seed data
await mock.pipe(await openapi({
  spec: './openapi.yaml',
  seed: {
    users: [
      { userId: 1, name: 'Alice', email: 'alice@example.com' },
      { userId: 2, name: 'Bob', email: 'bob@example.com' }
    ],
    posts: { count: 10 },  // Auto-generate 10 posts from schema
    tags: './seed/tags.json'  // Load from file
  }
}));

// Or load inline spec
await mock.pipe(await openapi({
  spec: {
    openapi: '3.0.0',
    paths: {
      '/users': {
        get: {
          responses: {
            '200': {
              description: 'List users',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'integer' },
                        name: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}));

// CRUD operations work automatically
await mock.handle('GET', '/users');           // List all users
await mock.handle('GET', '/users/1');         // Get user by ID
await mock.handle('POST', '/users', {         // Create user
  body: { name: 'Charlie', email: 'charlie@example.com' }
});
await mock.handle('PUT', '/users/1', {        // Update user
  body: { name: 'Alice Updated', email: 'alice@example.com' }
});
await mock.handle('DELETE', '/users/1');      // Delete user
```

**CRUD Detection**:
The plugin automatically detects CRUD resources by analyzing path patterns. For example:
- `/users` + `/users/{id}` → Detected as "users" CRUD resource
- `/posts` + `/posts/{postId}` → Detected as "posts" CRUD resource

Detected CRUD resources get full in-memory collection behavior with create, read, update, delete operations.

**Seed Data Matching**:
Seed data objects must include an ID field that matches the path parameter name from your OpenAPI spec:
```typescript
// If your spec defines /users/{userId}, seed data needs userId field:
seed: {
  users: [
    { userId: 1, name: 'Alice' },  // Matches path param {userId}
    { userId: 2, name: 'Bob' }
  ]
}
```

## CLI (`@schmock/cli`)

### `createCliServer(options)`

Programmatically start a Schmock server from an OpenAPI spec. Useful for integration tests or custom tooling.

```typescript
async function createCliServer(options: CliOptions): Promise<CliServer>
```

```typescript
interface CliOptions {
  spec: string;           // Path to OpenAPI/Swagger spec file
  port?: number;          // Port to listen on (default: 3000)
  hostname?: string;      // Hostname to bind to (default: '127.0.0.1')
  seed?: string;          // Path to JSON file with seed data
  cors?: boolean;         // Enable CORS for all responses (default: false)
  debug?: boolean;        // Enable debug logging (default: false)
}

interface CliServer {
  server: Server;         // Node http.Server instance
  port: number;           // Actual port (useful when port=0)
  hostname: string;       // Bound hostname
  close(): void;          // Stop the server
}
```

**Example**:
```typescript
import { createCliServer } from '@schmock/cli';

const server = await createCliServer({
  spec: './petstore.yaml',
  port: 8080,
  cors: true,
  seed: './seed.json'
});

console.log(`Mock server on port ${server.port}`);

// Later...
server.close();
```

### CLI Usage

```bash
schmock <spec> [options]
schmock --spec <path> [options]
```

The spec file can be passed as a positional argument or via `--spec`. The positional form is the simplest way to start a server.

**Options**:

| Flag | Description | Default |
|------|-------------|---------|
| `--spec <path>` | OpenAPI/Swagger spec file (or pass as first argument) | — |
| `--port <number>` | Port to listen on | `3000` |
| `--hostname <host>` | Hostname to bind to | `127.0.0.1` |
| `--seed <path>` | JSON file with seed data | — |
| `--cors` | Enable CORS for all responses | `false` |
| `--debug` | Enable debug logging | `false` |
| `-h, --help` | Show help message | — |

**Example**:
```bash
# Simplest usage — just point at a spec
schmock swagger.json

# Custom port with CORS and seed data
schmock ./api.yaml --port 8080 --cors --seed ./seed.json

# Equivalent using --spec flag
schmock --spec ./petstore.yaml --port 3000
```

### `parseCliArgs(args)`

Parse CLI arguments into a `CliOptions` object.

```typescript
function parseCliArgs(args: string[]): CliOptions & { help: boolean }
```

### `run(args)`

Entry point for the CLI binary. Parses args, starts the server, and handles graceful shutdown (SIGINT/SIGTERM).

```typescript
async function run(args: string[]): Promise<void>
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
  fakerPlugin({ schema: invalidSchema });
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
