# API Documentation

Complete API reference for Schmock framework.

## Core API

### `schmock(config?)`

Creates a new callable Schmock mock instance.

```typescript
function schmock(config?: GlobalConfig): CallableMockInstance
```

**Parameters**:
- `config?: GlobalConfig` - Optional global configuration

**Global Configuration Interface**:
```typescript
interface GlobalConfig {
  debug?: boolean;                    // Enable debug logging
  namespace?: string;                 // URL prefix for all routes
  state?: any;                       // Initial shared state object
  delay?: number | [number, number]; // Response delay in ms or range
}
```

**Returns**: `CallableMockInstance` - A callable instance for defining routes and handling requests.

**Example**:
```typescript
import { schmock } from '@schmock/core';

// Basic usage
const mock = schmock();

// With configuration
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

Define routes by calling the mock instance directly:

```typescript
mock(route: string, generator: Generator, config: RouteConfig): CallableMockInstance
```

**Parameters**:
- `route: string` - Route pattern in format `'METHOD /path'` (e.g., `'GET /users/:id'`)
- `generator: Generator` - Response generator (function, static data, or schema)
- `config: RouteConfig` - Route-specific configuration

**Route Configuration Interface**:
```typescript
interface RouteConfig {
  contentType: string;  // MIME type: 'application/json', 'text/plain', etc.
  // Additional route-specific options can be added here
}
```

**Generator Types**:
- **Function**: `(context: RequestContext) => ResponseResult` - Called on each request
- **Static Data**: `any` - Returned as-is (detected when not a function)
- **JSON Schema**: `JSONSchema7` - Used with schema plugin for data generation

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
}, { 
  contentType: 'application/json' 
})

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

#### Plugin Pipeline

Chain plugins using the `.pipe()` method:

```typescript
pipe(plugin: Plugin): CallableMockInstance
```

**Parameters**:
- `plugin: Plugin` - Plugin instance to add to the pipeline

**Returns**: `CallableMockInstance` - The same instance for method chaining

**Example**:
```typescript
import { schemaPlugin } from '@schmock/schema'
import { validationPlugin } from '@schmock/validation'

mock('GET /users', userSchema, { contentType: 'application/json' })
  .pipe(schemaPlugin())
  .pipe(validationPlugin({ strict: true }))
  .pipe(cachingPlugin({ ttl: 300000 }))
```

#### Request Handling

##### `.handle(method, path, options?)`
Handle a request and return a response.

```typescript
handle(
  method: HttpMethod, 
  path: string, 
  options?: RequestOptions
): Promise<Response>
```

**Parameters**:
- `method: HttpMethod` - HTTP method
- `path: string` - Request path
- `options?: RequestOptions` - Request options (headers, body, query)

**Returns**: `Promise<Response>` - Response object with status, body, and headers

**Example**:
```typescript
const response = await mock.handle('GET', '/users/123', {
  headers: { 'Authorization': 'Bearer token' },
  query: { include: 'profile' }
});

console.log(response.status); // 200
console.log(response.body);   // { id: 123, name: "John Doe", ... }
console.log(response.headers); // { "Content-Type": "application/json" }
```

### Types

#### `HttpMethod`
```typescript
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD'
```

#### `Generator`
```typescript
type Generator = 
  | GeneratorFunction
  | StaticData
  | JSONSchema7
```

#### `GeneratorFunction`
```typescript
type GeneratorFunction = (context: RequestContext) => ResponseResult | Promise<ResponseResult>
```

#### `RequestContext`
```typescript
interface RequestContext {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;    // Route parameters (:id, :slug, etc.)
  query: Record<string, string>;     // Query string parameters
  headers: Record<string, string>;   // Request headers
  body?: any;                        // Request body (POST, PUT, PATCH)
  state: any;                        // Shared mutable state
}
```

#### `ResponseResult`
Response functions can return any of these formats:
```typescript
type ResponseResult = 
  | any                                              // Direct value (200 OK)
  | [number, any]                                    // [status, body]
  | [number, any, Record<string, string>]            // [status, body, headers]
```

#### `RequestOptions`
```typescript
interface RequestOptions {
  headers?: Record<string, string>;
  body?: any;
  query?: Record<string, string>;
}
```

#### `Response`
```typescript
interface Response {
  status: number;
  body: any;
  headers: Record<string, string>;
}
```

## Plugin System

### `Plugin` Interface

The new plugin system uses a simplified pipeline architecture with a single `process` method:

```typescript
interface Plugin {
  name: string;
  version?: string;
  
  /**
   * Process the request through this plugin
   * @param context - Plugin context with request details
   * @param response - Response from previous plugin (if any)
   * @returns Updated context and response
   */
  process(context: PluginContext, response?: any): PluginResult | Promise<PluginResult>;

  /**
   * Called when an error occurs during processing
   * @param error - The error that occurred
   * @param context - Plugin context
   * @returns Modified error, response data, or void to continue error propagation
   */
  onError?(error: Error, context: PluginContext): Error | ResponseResult | void | Promise<Error | ResponseResult | void>;
}
```

### `PluginResult`

```typescript
interface PluginResult {
  context: PluginContext;  // Updated context (required)
  response?: any;          // Response data (optional)
}
```

### `PluginContext`

```typescript
interface PluginContext {
  path: string;                        // Request path
  route: any;                          // Matched route configuration
  method: HttpMethod;                  // HTTP method
  params: Record<string, string>;      // Route parameters (:id, :slug, etc.)
  query: Record<string, string>;       // Query string parameters
  headers: Record<string, string>;     // Request headers
  body?: any;                          // Request body
  state: Map<string, any>;             // Shared state between plugins (per request)
  routeState?: any;                    // Route-specific persistent state
}
```

### Plugin Pipeline Execution

Plugins are executed in order using `.pipe()`:

1. **First Plugin**: Receives context with no response
2. **Subsequent Plugins**: Receive context + response from previous plugin
3. **Response Generation**: First plugin to set response becomes the generator
4. **Response Transformation**: Later plugins can modify the response

### Writing Plugins

#### Basic Plugin Example

```typescript
function loggingPlugin(): Plugin {
  return {
    name: 'logging',
    version: '1.0.0',
    
    process(context, response) {
      console.log(`${context.method} ${context.path}`)
      
      // Return context and pass through response
      return { context, response }
    }
  }
}
```

#### Response Generator Plugin

```typescript
function staticDataPlugin(data: any): Plugin {
  return {
    name: 'static-data',
    
    process(context, response) {
      // Only generate response if none exists
      if (!response) {
        return { context, response: data }
      }
      
      // Pass through existing response
      return { context, response }
    }
  }
}
```

#### Response Transformer Plugin

```typescript
function headerPlugin(headers: Record<string, string>): Plugin {
  return {
    name: 'headers',
    
    process(context, response) {
      if (response && Array.isArray(response)) {
        // Transform [status, body] to [status, body, headers]
        const [status, body, existingHeaders = {}] = response
        return {
          context,
          response: [status, body, { ...existingHeaders, ...headers }]
        }
      }
      
      return { context, response }
    }
  }
}
```

#### Error Handling Plugin

```typescript
function errorHandlerPlugin(): Plugin {
  return {
    name: 'error-handler',
    
    process(context, response) {
      return { context, response }
    },
    
    onError(error, context) {
      console.error(`Error in ${context.method} ${context.path}:`, error)
      
      // Return custom error response
      return {
        status: 500,
        body: { error: 'Internal server error', code: 'PLUGIN_ERROR' },
        headers: { 'Content-Type': 'application/json' }
      }
    }
  }
}
```

## Schema Plugin

### `schemaPlugin()`

Creates a schema plugin for JSON Schema-based data generation.

```typescript
function schemaPlugin(): Plugin
```

**Usage**:
```typescript
import { schemaPlugin } from '@schmock/schema';

const mock = schmock();

// Use JSON Schema as generator with schema plugin
mock('GET /users', {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      name: { type: 'string', faker: 'person.fullName' },
      email: { type: 'string', format: 'email' }
    }
  }
}, { contentType: 'application/json' })
  .pipe(schemaPlugin())
```

### `generateFromSchema(options)`

Generate data from a JSON Schema (used internally by schema plugin).

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
  mock: CallableMockInstance, 
  options?: ExpressAdapterOptions
): RequestHandler
```

**Parameters**:
- `mock: CallableMockInstance` - Schmock mock instance
- `options?: ExpressAdapterOptions` - Configuration options

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
app.listen(3000); // Responds at http://localhost:3000/api/users
```

## Angular Adapter

### `createSchmockInterceptor(mock, options?)`

Create an Angular HTTP interceptor class.

```typescript
function createSchmockInterceptor(
  mock: CallableMockInstance,
  options?: AngularAdapterOptions
): new () => HttpInterceptor
```

**Example**:
```typescript
import { createSchmockInterceptor } from '@schmock/angular';

const mock = schmock();
mock('GET /users', () => [{ id: 1, name: 'John' }], { 
  contentType: 'application/json' 
});

const InterceptorClass = createSchmockInterceptor(mock);

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
} from '@schmock/core';
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

const mock = schmock();

mock('GET /users/:id', ({ params }): User => ({
  id: parseInt(params.id),
  name: 'John Doe',
  email: 'john@example.com'
}), { contentType: 'application/json' });
```

### Error Handling
```typescript
// Always handle potential errors
try {
  const response = await mock.handle('GET', '/users');
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
// Create focused, single-purpose plugins with the new architecture
function timingPlugin(): Plugin {
  return {
    name: 'timing',
    version: '1.0.0',
    
    process(context, response) {
      // Add timing to context state
      context.state.set('startTime', Date.now());
      
      if (response && Array.isArray(response)) {
        const duration = Date.now() - (context.state.get('startTime') || 0);
        const [status, body, headers = {}] = response;
        
        return {
          context,
          response: [status, body, {
            ...headers,
            'X-Response-Time': `${duration}ms`
          }]
        };
      }
      
      return { context, response };
    }
  };
}
```

### Content Type Validation
```typescript
// Use contentType for runtime validation
const mock = schmock();

// Generator function
mock('GET /users', () => [...users], { 
  contentType: 'application/json' 
});

// Static data  
mock('GET /config', staticConfig, { 
  contentType: 'application/json' 
});

// JSON Schema (with schema plugin)
mock('GET /generated', userSchema, { 
  contentType: 'application/json' 
}).pipe(schemaPlugin());
```