# Plugin Development Guide

This guide covers how to create custom plugins for Schmock's new pipeline architecture using `.pipe()`.

## Plugin Structure

A Schmock plugin is an object that implements the simplified `Plugin` interface:

```typescript
interface Plugin {
  name: string;
  version?: string;

  /**
   * Called when the plugin is added to the pipeline via .pipe()
   * @param instance - The callable mock instance
   */
  install?(instance: CallableMockInstance): void;

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

## Plugin Pipeline Architecture

The new architecture is based on a linear pipeline where:

1. **Each plugin** receives context + response from the previous plugin
2. **First plugin** to set response becomes the generator
3. **Later plugins** can transform the response
4. **All plugins** can modify the context (headers, state, etc.)

## Install Hook

Plugins can optionally implement the `install()` method to register routes at `.pipe()` time. The install hook receives the callable mock instance, allowing plugins to call `instance('GET /path', generator)` to register routes programmatically.

This pattern is used by `@schmock/openapi` to auto-register CRUD routes from an OpenAPI specification.

### Example: Auto-Route Plugin

```typescript
function autoRoutePlugin(routes: Record<string, Function>): Plugin {
  return {
    name: 'auto-routes',
    install(instance) {
      for (const [key, handler] of Object.entries(routes)) {
        instance(key as any, handler);
      }
    },
    process(context, response) {
      return { context, response };
    }
  };
}

// Usage
const mock = schmock();
mock.pipe(autoRoutePlugin({
  'GET /users': () => [{ id: 1, name: 'John' }],
  'POST /users': ({ body }) => ({ id: 2, ...body })
}));

// Routes are now registered and ready to handle requests
const response = await mock.handle('GET', '/users');
```

## Plugin Context & Result

The `PluginContext` provides access to request data:

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

interface PluginResult {
  context: PluginContext;  // Updated context (required)
  response?: any;          // Response data (optional)
}
```

## Plugin Examples

### Simple Logging Plugin

```typescript
function loggingPlugin(): Plugin {
  return {
    name: "logger",
    version: "1.0.0",
    
    process(context, response) {
      console.log(`${context.method} ${context.path}`);
      
      if (response) {
        console.log(`Response generated for ${context.path}:`, response);
      }
      
      // Pass through context and response unchanged
      return { context, response };
    }
  };
}

// Usage
const mock = schmock();
mock('GET /users', () => [...users], { contentType: 'application/json' })
  .pipe(loggingPlugin());
```

### Authentication Plugin

```typescript
function authPlugin(): Plugin {
  return {
    name: "auth",
    version: "1.0.0",
    
    process(context, response) {
      const token = context.headers.authorization;
      
      // Check if route requires authentication
      if (!token && context.route.protected) {
        throw new Error("Authentication required");
      }
      
      if (token) {
        // Validate token and add user to context state
        context.state.set('user', validateToken(token));
      }
      
      return { context, response };
    },
    
    onError(error, context) {
      if (error.message === "Authentication required") {
        return {
          status: 401,
          body: { error: "Unauthorized" },
          headers: { 'Content-Type': 'application/json' }
        };
      }
      // Let other plugins handle different errors
      return error;
    }
  };
}

function validateToken(token: string) {
  // Token validation logic
  return { id: 1, name: "User", roles: ["user"] };
}

// Usage
const mock = schmock();
mock('GET /profile', ({ state }) => {
  const user = state.get('user');
  return { profile: user };
}, { contentType: 'application/json' })
  .pipe(authPlugin());
```

### CORS Plugin

```typescript
function corsPlugin(options: { origin?: string; methods?: string[] } = {}): Plugin {
  const corsHeaders = {
    "Access-Control-Allow-Origin": options.origin || "*",
    "Access-Control-Allow-Methods": (options.methods || ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']).join(', '),
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };

  return {
    name: "cors",
    version: "1.0.0",
    
    process(context, response) {
      if (response && Array.isArray(response)) {
        // Handle [status, body, headers] format
        const [status, body, existingHeaders = {}] = response;
        return {
          context,
          response: [status, body, { ...existingHeaders, ...corsHeaders }]
        };
      }
      
      // For simple responses, we'll let the default handler add headers
      // Store CORS headers in context for later processing
      context.state.set('corsHeaders', corsHeaders);
      
      return { context, response };
    }
  };
}

// Usage
const mock = schmock();
mock('GET /api/data', () => ({ data: 'value' }), { contentType: 'application/json' })
  .pipe(corsPlugin({ origin: 'https://myapp.com' }));
```

### Response Transformation Plugin

```typescript
function wrapperPlugin(): Plugin {
  return {
    name: "wrapper",
    version: "1.0.0",
    
    process(context, response) {
      if (response) {
        // Wrap existing response with metadata
        const wrappedResponse = {
          data: response,
          meta: {
            timestamp: new Date().toISOString(),
            path: context.path,
            method: context.method,
            requestId: Math.random().toString(36).substring(7)
          }
        };
        
        return { context, response: wrappedResponse };
      }
      
      return { context, response };
    }
  };
}

// Usage
const mock = schmock();
mock('GET /users', () => [{ id: 1, name: 'John' }], { contentType: 'application/json' })
  .pipe(wrapperPlugin());
// Response: { data: [{ id: 1, name: 'John' }], meta: { timestamp: "...", path: "/users", ... } }
```

### Response Generator Plugin

```typescript
function staticDataPlugin(data: any): Plugin {
  return {
    name: "static-data",
    version: "1.0.0",
    
    process(context, response) {
      // Only generate response if none exists yet
      if (!response) {
        return { context, response: data };
      }
      
      // Pass through existing response
      return { context, response };
    }
  };
}

// Usage
const mock = schmock();
mock('GET /config', null, { contentType: 'application/json' })
  .pipe(staticDataPlugin({ version: '1.0.0', features: ['auth', 'api'] }));
```

## Plugin Ordering & Chaining

Plugins execute in the order they are chained with `.pipe()`:

```typescript
const mock = schmock();

// Plugins execute left to right
mock('GET /users', userGenerator, { contentType: 'application/json' })
  .pipe(authPlugin())      // 1st: Check authentication
  .pipe(loggingPlugin())   // 2nd: Log the request
  .pipe(wrapperPlugin())   // 3rd: Wrap response with metadata
  .pipe(corsPlugin());     // 4th: Add CORS headers
```

## Error Handling

Plugins can handle and transform errors using the `onError` hook:

```typescript
function errorHandlerPlugin(): Plugin {
  return {
    name: "error-handler",
    version: "1.0.0",
    
    process(context, response) {
      // Normal processing
      return { context, response };
    },
    
    onError(error, context) {
      console.error(`Error in ${context.method} ${context.path}:`, error);
      
      // Transform specific error types
      if (error.name === "ValidationError") {
        return {
          status: 400,
          body: { 
            error: "Validation failed", 
            details: error.message,
            code: 'VALIDATION_ERROR'
          },
          headers: { 'Content-Type': 'application/json' }
        };
      }
      
      if (error.message === "Authentication required") {
        return {
          status: 401,
          body: { error: "Unauthorized", code: 'AUTH_REQUIRED' },
          headers: { 'Content-Type': 'application/json' }
        };
      }
      
      // Return generic error response
      return {
        status: 500,
        body: { 
          error: "Internal server error", 
          code: 'INTERNAL_ERROR',
          requestId: context.state.get('requestId')
        },
        headers: { 'Content-Type': 'application/json' }
      };
    }
  };
}

// Usage: Add error handling as the last plugin
mock('POST /users', createUserHandler, { contentType: 'application/json' })
  .pipe(validationPlugin())
  .pipe(authPlugin())
  .pipe(errorHandlerPlugin());  // Handle all errors from previous plugins
```

## Advanced Plugin Patterns

### Conditional Processing

```typescript
function conditionalPlugin(condition: (context: PluginContext) => boolean): Plugin {
  return {
    name: "conditional",
    
    process(context, response) {
      if (condition(context)) {
        // Apply conditional logic
        context.state.set('conditionMet', true);
      }
      
      return { context, response };
    }
  };
}

// Usage
mock('GET /admin/users', adminHandler, { contentType: 'application/json' })
  .pipe(conditionalPlugin(ctx => ctx.path.startsWith('/admin')))
  .pipe(adminAuthPlugin());
```

### State Sharing Between Plugins

```typescript
function requestIdPlugin(): Plugin {
  return {
    name: "request-id",
    
    process(context, response) {
      const requestId = Math.random().toString(36).substring(7);
      context.state.set('requestId', requestId);
      
      return { context, response };
    }
  };
}

function timingPlugin(): Plugin {
  return {
    name: "timing",
    
    process(context, response) {
      const startTime = Date.now();
      context.state.set('startTime', startTime);
      
      if (response && Array.isArray(response)) {
        const duration = Date.now() - startTime;
        const requestId = context.state.get('requestId');
        
        const [status, body, headers = {}] = response;
        return {
          context,
          response: [status, body, {
            ...headers,
            'X-Request-ID': requestId,
            'X-Response-Time': `${duration}ms`
          }]
        };
      }
      
      return { context, response };
    }
  };
}

// Usage: Plugins share state through context.state Map
mock('GET /users', userHandler, { contentType: 'application/json' })
  .pipe(requestIdPlugin())  // Sets requestId
  .pipe(timingPlugin());    // Uses requestId from previous plugin
```

## Best Practices

### 1. Use TypeScript

Always develop plugins in TypeScript for better type safety:

```typescript
import type { Plugin, PluginContext, PluginResult } from '@schmock/core';

export function myPlugin(): Plugin {
  return {
    name: "my-plugin",
    version: "1.0.0",
    
    process(context: PluginContext, response?: any): PluginResult {
      // Plugin implementation with full type safety
      return { context, response };
    }
  };
}
```

### 2. Handle Async Operations

Use async/await for asynchronous operations:

```typescript
function asyncPlugin(): Plugin {
  return {
    name: "async-plugin",
    version: "1.0.0",
    
    async process(context, response) {
      // Async operation
      const userData = await fetchUserData(context.headers['user-id']);
      context.state.set('userData', userData);
      
      return { context, response };
    }
  };
}
```

### 3. Validate Plugin Configuration

```typescript
interface CachePluginOptions {
  ttl?: number;
  maxSize?: number;
}

function cachePlugin(options: CachePluginOptions = {}): Plugin {
  const { ttl = 300, maxSize = 1000 } = options;
  
  if (ttl <= 0) {
    throw new Error("TTL must be positive");
  }
  
  if (maxSize <= 0) {
    throw new Error("Max size must be positive");
  }
  
  return {
    name: "cache",
    version: "1.0.0",
    
    process(context, response) {
      // Implementation with validated options
      return { context, response };
    }
  };
}
```

### 4. Immutable Context Handling

Always return a new context object or ensure proper state management:

```typescript
// Good - return new context with modifications
process(context, response) {
  const newContext = {
    ...context,
    headers: { ...context.headers, 'X-Plugin-Processed': 'true' }
  };
  return { context: newContext, response };
}

// Also good - modify context.state (which is a Map) and return
process(context, response) {
  context.state.set('timestamp', Date.now());
  return { context, response };
}

// Bad - mutating context properties directly
process(context, response) {
  context.headers['X-Plugin-Processed'] = 'true'; // Don't mutate directly
  return { context, response };
}
```

### 5. Use Meaningful Names and Versions

```typescript
function rateLimitPlugin(): Plugin {
  return {
    name: "rate-limiter",
    version: "2.1.0", // Follow semantic versioning
    
    process(context, response) {
      // Implementation
      return { context, response };
    }
  };
}
```

### 6. Pipeline-Aware Design

Design plugins to work well in pipelines:

```typescript
function transformerPlugin(): Plugin {
  return {
    name: "transformer",
    
    process(context, response) {
      // Only transform if there's a response to transform
      if (response) {
        const transformedResponse = transform(response);
        return { context, response: transformedResponse };
      }
      
      // Pass through unchanged if no response yet
      return { context, response };
    }
  };
}
```

## Testing Plugins

Test your plugins thoroughly with the new pipeline architecture:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { myPlugin } from './my-plugin';

describe('MyPlugin', () => {
  it('should process context and response correctly', async () => {
    const plugin = myPlugin();
    const context = {
      path: '/test',
      route: {},
      method: 'GET' as const,
      params: {},
      query: {},
      headers: {},
      body: undefined,
      state: new Map(),
      routeState: {}
    };
    
    const result = await plugin.process(context, undefined);
    
    expect(result).toBeDefined();
    expect(result.context).toBeDefined();
    expect(result.context.state.get('processed')).toBe(true);
  });

  it('should handle existing response correctly', async () => {
    const plugin = myPlugin();
    const context = {
      path: '/test',
      route: {},
      method: 'GET' as const,
      params: {},
      query: {},
      headers: {},
      body: undefined,
      state: new Map(),
      routeState: {}
    };
    const existingResponse = { data: 'test' };
    
    const result = await plugin.process(context, existingResponse);
    
    expect(result.response).toBeDefined();
    expect(result.response.data).toBe('test');
  });

  it('should handle errors correctly', async () => {
    const plugin = myPlugin();
    const context = {
      path: '/test',
      route: {},
      method: 'GET' as const,
      params: {},
      query: {},
      headers: {},
      body: undefined,
      state: new Map(),
      routeState: {}
    };
    const error = new Error('Test error');

    const result = plugin.onError?.(error, context);
    
    expect(result).toBeDefined();
  });
});
```

### Integration Testing

Test plugins in real pipeline scenarios:

```typescript
import { schmock } from '@schmock/core';
import { myPlugin } from './my-plugin';

describe('MyPlugin Integration', () => {
  it('should work in a pipeline', async () => {
    const mock = schmock();
    
    mock('GET /test', () => ({ original: 'data' }), { 
      contentType: 'application/json' 
    }).pipe(myPlugin());
    
    const response = await mock.handle('GET', '/test');
    
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('modified', true);
  });
});
```

## Built-in Plugins

Schmock includes four official plugins that serve as reference implementations for different plugin patterns:

### `@schmock/schema`
JSON Schema-based data generation using json-schema-faker. Demonstrates the **generator plugin pattern** where the plugin sets the response if none exists yet.

```typescript
mock('GET /users', null, { contentType: 'application/json' })
  .pipe(schema({ type: 'array', items: { ... } }));
```

### `@schmock/validation`
Request and response validation using AJV. Demonstrates the **guard plugin pattern** where the plugin validates data and throws errors to prevent invalid requests/responses.

```typescript
mock('POST /users', handler, { contentType: 'application/json' })
  .pipe(validation({ request: { body: userSchema } }));
```

### `@schmock/query`
Pagination, sorting, and filtering for array responses. Demonstrates the **transformer plugin pattern** where the plugin modifies existing response data.

```typescript
mock('GET /users', () => allUsers, { contentType: 'application/json' })
  .pipe(query());
```

### `@schmock/openapi`
Auto-registers CRUD routes from OpenAPI specifications. Demonstrates the **install hook pattern** where the plugin uses `install()` to register routes at pipeline setup time.

```typescript
const mock = schmock();
mock.pipe(openapi({ spec: './petstore.json' }));
// Routes are now auto-registered from the spec
```

## Publishing Plugins

When publishing plugins as npm packages:

1. Use the naming convention: `schmock-plugin-{name}`
2. Include proper TypeScript definitions
3. Add comprehensive documentation
4. Include usage examples
5. Follow semantic versioning
6. Test with the new pipeline architecture

Example `package.json`:

```json
{
  "name": "schmock-plugin-auth",
  "version": "2.0.0",
  "description": "Authentication plugin for Schmock v2 pipeline architecture",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "keywords": ["schmock", "plugin", "auth", "mock", "pipeline"],
  "peerDependencies": {
    "@schmock/core": "^1.0.0"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "setup": "bun run setup-hooks || npm run setup-hooks || echo 'Run setup manually'",
    "build": "tsc",
    "test": "vitest",
    "test:all": "npm run typecheck && npm test",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "lint:fix": "biome check --write src/"
  }
}
```

### Plugin README Template

```markdown
# schmock-plugin-auth

Authentication plugin for Schmock v2 pipeline architecture.

## Installation

\`\`\`bash
npm install schmock-plugin-auth
\`\`\`

## Usage

\`\`\`typescript
import { schmock } from '@schmock/core';
import { authPlugin } from 'schmock-plugin-auth';

const mock = schmock();

mock('GET /protected', protectedHandler, { contentType: 'application/json' })
  .pipe(authPlugin({ 
    requireToken: true,
    validateToken: (token) => validateJWT(token)
  }));
\`\`\`

## API

### authPlugin(options)

- \`options.requireToken\`: boolean - Require authentication token
- \`options.validateToken\`: function - Custom token validation

## License

MIT
```

---

## Plugin Development Best Practices

### Development Workflow

Follow Schmock's quality standards when developing plugins:

#### Setup
```sh
# Clone Schmock for plugin development  
git clone <schmock-repo>
cd schmock
bun install
bun run setup  # Configure Git hooks

# Create plugin in separate directory
mkdir my-schmock-plugin
cd my-schmock-plugin
npm init
# ... plugin development
```

#### Quality Assurance
- **Automated Testing**: Use Vitest with comprehensive test coverage (follow Schmock's 1500+ tests example)
- **Type Safety**: Develop in TypeScript with strict mode enabled
- **Linting**: Use Biome for consistent code style with auto-fixing
- **Git Hooks**: Configure pre-commit hooks for automated quality checks

#### Testing Against Schmock Core
```typescript
// Test your plugin with the actual Schmock implementation
import { schmock } from '@schmock/core';
import { myPlugin } from './src/my-plugin';

describe('MyPlugin Integration', () => {
  it('works with Schmock pipeline', async () => {
    const mock = schmock();
    
    mock('GET /test', () => ({ data: 'test' }), { 
      contentType: 'application/json' 
    }).pipe(myPlugin());
    
    const response = await mock.handle('GET', '/test');
    // Assert plugin behavior with comprehensive test coverage
  });
});
```

### Recommended Package Scripts
```json
{
  "scripts": {
    "setup": "bun run setup-hooks || npm run setup-hooks || echo 'Configure Git hooks manually'",
    "build": "tsc",
    "test": "vitest",
    "test:all": "npm run typecheck && npm test",  
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "lint:fix": "biome check --write src/"
  }
}
```