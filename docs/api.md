# API Documentation

Complete API reference for Schmock framework.

## Core API

### `schmock()`

Creates a new Schmock mock instance.

```typescript
function schmock(): MockInstance
```

**Returns**: `MockInstance` - A new mock instance for defining routes and handling requests.

**Example**:
```typescript
import { schmock } from '@schmock/builder';

const mock = schmock();
```

### `MockInstance`

The main interface for defining routes and handling requests.

#### Methods

##### `.get(path, response)`
Define a GET route.

```typescript
get(path: string, response: RouteResponse): MockInstance
```

**Parameters**:
- `path: string` - URL path pattern (supports parameters like `/users/:id`)
- `response: RouteResponse` - Response definition (function, object, or schema)

**Example**:
```typescript
mock.get('/users/:id', (req) => ({ id: req.params.id, name: 'John' }));
```

##### `.post(path, response)`
Define a POST route.

```typescript
post(path: string, response: RouteResponse): MockInstance
```

##### `.put(path, response)`
Define a PUT route.

```typescript
put(path: string, response: RouteResponse): MockInstance
```

##### `.delete(path, response)`
Define a DELETE route.

```typescript
delete(path: string, response: RouteResponse): MockInstance
```

##### `.patch(path, response)`
Define a PATCH route.

```typescript
patch(path: string, response: RouteResponse): MockInstance
```

##### `.options(path, response)`
Define an OPTIONS route.

```typescript
options(path: string, response: RouteResponse): MockInstance
```

##### `.head(path, response)`
Define a HEAD route.

```typescript
head(path: string, response: RouteResponse): MockInstance
```

##### `.plugin(plugin)`
Add a plugin to the mock instance.

```typescript
plugin(plugin: Plugin): MockInstance
```

**Parameters**:
- `plugin: Plugin` - Plugin implementation

**Example**:
```typescript
mock.plugin(schemaPlugin());
```

##### `.handle(method, path, options?)`
Handle a request and return a response.

```typescript
handle(
  method: HttpMethod, 
  path: string, 
  options?: RequestOptions
): Promise<Response | null>
```

**Parameters**:
- `method: HttpMethod` - HTTP method
- `path: string` - Request path
- `options?: RequestOptions` - Request options (headers, body, query)

**Returns**: `Promise<Response | null>` - Response object or null if no route matches

**Example**:
```typescript
const response = await mock.handle('GET', '/users/123', {
  headers: { 'Authorization': 'Bearer token' },
  query: { include: 'profile' }
});
```

### Types

#### `HttpMethod`
```typescript
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD'
```

#### `RouteResponse`
```typescript
type RouteResponse = 
  | ResponseFunction
  | ResponseObject  
  | JSONSchema7
  | any
```

#### `ResponseFunction`
```typescript
type ResponseFunction = (context: RequestContext) => ResponseResult | Promise<ResponseResult>
```

#### `RequestContext`
```typescript
interface RequestContext {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: any;
  state: any;
}
```

#### `ResponseResult`
```typescript
interface ResponseResult {
  status?: number;
  headers?: Record<string, string>;
  body?: any;
}
```

#### `RequestOptions`
```typescript
interface RequestOptions {
  headers?: Record<string, string>;
  body?: any;
  query?: Record<string, string>;
}
```

## Plugin System

### `Plugin` Interface

```typescript
interface Plugin {
  name: string;
  version: string;
  enforce?: "pre" | "post";
  
  beforeRequest?(context: PluginContext): PluginContext | void | Promise<PluginContext | void>;
  beforeGenerate?(context: PluginContext): any | void | Promise<any | void>;
  generate?(context: PluginContext): any | Promise<any>;
  afterGenerate?(data: any, context: PluginContext): any | Promise<any>;
  beforeResponse?(response: ResponseResult, context: PluginContext): ResponseResult | void | Promise<ResponseResult | void>;
  onError?(error: Error, context: PluginContext): Error | ResponseResult | void | Promise<Error | ResponseResult | void>;
  transform?(data: any, context: PluginContext): any | Promise<any>;
}
```

### `PluginContext`

```typescript
interface PluginContext {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: any;
  route: Route;
  state: any;
}
```

### Plugin Lifecycle Hooks

#### `beforeRequest(context)`
Modify request data before processing.

**Parameters**: `context: PluginContext`
**Returns**: `PluginContext | void | Promise<PluginContext | void>`

#### `beforeGenerate(context)`
Execute before data generation.

**Parameters**: `context: PluginContext`
**Returns**: `any | void | Promise<any | void>`

#### `generate(context)`
Generate response data.

**Parameters**: `context: PluginContext`
**Returns**: `any | Promise<any>`

#### `afterGenerate(data, context)`
Post-process generated data.

**Parameters**: 
- `data: any` - Generated data
- `context: PluginContext` - Request context

**Returns**: `any | Promise<any>`

#### `beforeResponse(response, context)`
Final response transformation.

**Parameters**:
- `response: ResponseResult` - Response object
- `context: PluginContext` - Request context

**Returns**: `ResponseResult | void | Promise<ResponseResult | void>`

#### `onError(error, context)`
Handle errors during processing.

**Parameters**:
- `error: Error` - The error that occurred
- `context: PluginContext` - Request context

**Returns**: `Error | ResponseResult | void | Promise<Error | ResponseResult | void>`

#### `transform(data, context)`
Legacy transform hook for backward compatibility.

**Parameters**:
- `data: any` - Data to transform
- `context: PluginContext` - Request context

**Returns**: `any | Promise<any>`

## Schema Plugin

### `schemaPlugin()`

Creates a schema plugin for JSON Schema-based data generation.

```typescript
function schemaPlugin(): Plugin
```

**Usage**:
```typescript
import { schemaPlugin } from '@schmock/schema';

const mock = schmock().plugin(schemaPlugin());
```

### `generateFromSchema(options)`

Generate data from a JSON Schema.

```typescript
function generateFromSchema(options: SchemaGenerationContext): any
```

**Parameters**:
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

### Schema Route Extensions

Routes can include schema-specific properties:

```typescript
interface SchemaRouteExtension {
  schema?: JSONSchema7;
  count?: number;
  overrides?: Record<string, any>;
}
```

**Example**:
```typescript
mock.get('/users', {
  schema: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        name: { type: 'string', faker: 'person.fullName' },
        email: { type: 'string', format: 'email' }
      }
    }
  },
  count: 5
});
```

### Error Types

#### `SchemaValidationError`
```typescript
class SchemaValidationError extends Error {
  constructor(path: string, message: string, suggestion?: string)
}
```

#### `SchemaGenerationError`
```typescript
class SchemaGenerationError extends Error {
  constructor(path: string, originalError: Error, schema?: JSONSchema7)
}
```

#### `ResourceLimitError`
```typescript
class ResourceLimitError extends Error {
  constructor(limitType: string, limit: number, actual: number)
}
```

## Express Adapter

### `toExpress(mock, options?)`

Convert a Schmock instance to Express middleware.

```typescript
function toExpress(
  mock: MockInstance, 
  options?: ExpressAdapterOptions
): RequestHandler
```

**Parameters**:
- `mock: MockInstance` - Schmock mock instance
- `options?: ExpressAdapterOptions` - Configuration options

### `ExpressAdapterOptions`

```typescript
interface ExpressAdapterOptions {
  errorFormatter?: (error: Error, req: Request) => any;
  passErrorsToNext?: boolean;
  transformHeaders?: (headers: Request['headers']) => Record<string, string>;
  transformQuery?: (query: Request['query']) => Record<string, string>;
  beforeRequest?: (req: Request, res: Response) => RequestTransform | void | Promise<any>;
  beforeResponse?: (
    schmockResponse: Response,
    req: Request,
    res: Response
  ) => Response | void | Promise<Response | void>;
}
```

**Example**:
```typescript
import express from 'express';
import { toExpress } from '@schmock/express';

const app = express();

app.use('/api', toExpress(mock, {
  errorFormatter: (error, req) => ({
    error: error.message,
    path: req.path,
    timestamp: new Date().toISOString()
  }),
  beforeRequest: (req, res) => {
    console.log(`Processing ${req.method} ${req.path}`);
  }
}));
```

## Angular Adapter

### `createSchmockInterceptor(mock, options?)`

Create an Angular HTTP interceptor class.

```typescript
function createSchmockInterceptor(
  mock: MockInstance,
  options?: AngularAdapterOptions
): new () => HttpInterceptor
```

### `provideSchmockInterceptor(mock, options?)`

Create a provider configuration for Angular DI.

```typescript
function provideSchmockInterceptor(
  mock: MockInstance,
  options?: AngularAdapterOptions
): Provider
```

### `AngularAdapterOptions`

```typescript
interface AngularAdapterOptions {
  baseUrl?: string;
  passthrough?: boolean;
  errorFormatter?: (error: Error, request: HttpRequest<any>) => any;
  transformRequest?: (request: HttpRequest<any>) => RequestTransform;
  transformResponse?: (
    response: Response,
    request: HttpRequest<any>
  ) => Response;
}
```

**Example**:
```typescript
// In Angular module or component
import { createSchmockInterceptor } from '@schmock/angular';

const InterceptorClass = createSchmockInterceptor(mock, {
  baseUrl: '/api',
  passthrough: true
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

## Error Handling

### Standard Error Types

All packages export standard error classes:

```typescript
import { 
  SchmockError,
  SchemaValidationError,
  SchemaGenerationError,
  ResourceLimitError 
} from '@schmock/builder';
```

### Error Context

Errors include contextual information:

```typescript
try {
  await mock.handle('GET', '/api/invalid');
} catch (error) {
  if (error instanceof SchemaValidationError) {
    console.log('Path:', error.path);
    console.log('Issue:', error.message);
    console.log('Suggestion:', error.suggestion);
  }
}
```

## Best Practices

### Type Safety
```typescript
// Use TypeScript for better development experience
interface User {
  id: number;
  name: string;
  email: string;
}

mock.get('/users/:id', (req): User => ({
  id: parseInt(req.params.id),
  name: 'John Doe',
  email: 'john@example.com'
}));
```

### Error Handling
```typescript
// Always handle potential errors
try {
  const response = await mock.handle('GET', '/api/users');
  // Process response
} catch (error) {
  if (error instanceof ResourceLimitError) {
    // Handle resource limits
  } else if (error instanceof SchemaValidationError) {
    // Handle schema issues
  } else {
    // Handle other errors
  }
}
```

### Plugin Development
```typescript
// Create focused, single-purpose plugins
function timingPlugin(): Plugin {
  return {
    name: 'timing',
    version: '1.0.0',
    beforeRequest(context) {
      context.state.startTime = Date.now();
    },
    beforeResponse(response, context) {
      const duration = Date.now() - context.state.startTime;
      return {
        ...response,
        headers: {
          ...response.headers,
          'X-Response-Time': `${duration}ms`
        }
      };
    }
  };
}
```