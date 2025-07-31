# Plugin Development Guide

This guide covers how to create custom plugins for Schmock to extend its functionality.

## Plugin Structure

A Schmock plugin is an object that implements the `Plugin` interface:

```typescript
interface Plugin {
  name: string;
  version: string;
  enforce?: "pre" | "post";
  
  // Lifecycle hooks
  beforeRequest?(context: PluginContext): PluginContext | void | Promise<PluginContext | void>;
  beforeGenerate?(context: PluginContext): any | void | Promise<any | void>;
  generate?(context: PluginContext): any | Promise<any>;
  afterGenerate?(data: any, context: PluginContext): any | Promise<any>;
  beforeResponse?(response: ResponseResult, context: PluginContext): ResponseResult | void | Promise<ResponseResult | void>;
  onError?(error: Error, context: PluginContext): Error | ResponseResult | void | Promise<Error | ResponseResult | void>;
  transform?(data: any, context: PluginContext): any | Promise<any>;
}
```

## Plugin Lifecycle

Plugins execute in the following order during request handling:

1. **beforeRequest** - Modify request data before processing
2. **beforeGenerate** - Prepare for data generation
3. **generate** - Generate response data (if no response function defined)
4. **afterGenerate** - Post-process generated data
5. **beforeResponse** - Final response transformation
6. **onError** - Handle errors (if they occur)

## Plugin Context

The `PluginContext` provides access to request data and route information:

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

## Plugin Examples

### Simple Logging Plugin

```typescript
function loggingPlugin(): Plugin {
  return {
    name: "logger",
    version: "1.0.0",
    
    beforeRequest(context) {
      console.log(`${context.method} ${context.path}`);
    },
    
    afterGenerate(data, context) {
      console.log(`Generated data for ${context.path}:`, data);
      return data;
    }
  };
}
```

### Authentication Plugin

```typescript
function authPlugin(): Plugin {
  return {
    name: "auth",
    version: "1.0.0",
    enforce: "pre", // Run before other plugins
    
    beforeRequest(context) {
      const token = context.headers.authorization;
      
      if (!token && context.route.protected) {
        throw new Error("Authentication required");
      }
      
      if (token) {
        // Validate token and add user to context
        context.state = { 
          ...context.state, 
          user: validateToken(token) 
        };
      }
      
      return context;
    },
    
    onError(error, context) {
      if (error.message === "Authentication required") {
        return {
          status: 401,
          body: { error: "Unauthorized" }
        };
      }
    }
  };
}

function validateToken(token: string) {
  // Token validation logic
  return { id: 1, name: "User" };
}
```

### CORS Plugin

```typescript
function corsPlugin(options: { origin?: string } = {}): Plugin {
  return {
    name: "cors",
    version: "1.0.0",
    
    beforeResponse(response, context) {
      const corsHeaders = {
        "Access-Control-Allow-Origin": options.origin || "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      };
      
      return {
        ...response,
        headers: {
          ...response.headers,
          ...corsHeaders
        }
      };
    }
  };
}
```

### Data Transformation Plugin

```typescript
function transformPlugin(): Plugin {
  return {
    name: "transformer",
    version: "1.0.0",
    
    afterGenerate(data, context) {
      // Add metadata to all responses
      return {
        data,
        meta: {
          timestamp: new Date().toISOString(),
          path: context.path,
          method: context.method
        }
      };
    }
  };
}
```

## Plugin Ordering

Use the `enforce` property to control plugin execution order:

- `enforce: "pre"` - Execute before normal plugins
- No `enforce` - Execute in registration order
- `enforce: "post"` - Execute after normal plugins

```typescript
const mock = schmock()
  .plugin(authPlugin()) // enforce: "pre" - runs first
  .plugin(loggingPlugin()) // no enforce - runs second
  .plugin(corsPlugin()) // no enforce - runs third
  .plugin(transformPlugin()); // enforce: "post" - runs last
```

## Error Handling

Plugins can handle and transform errors:

```typescript
function errorPlugin(): Plugin {
  return {
    name: "error-handler",
    version: "1.0.0",
    
    onError(error, context) {
      // Log error details
      console.error(`Error in ${context.path}:`, error);
      
      // Transform error response
      if (error.name === "ValidationError") {
        return {
          status: 400,
          body: {
            error: "Validation failed",
            details: error.message
          }
        };
      }
      
      // Return modified error
      const enhancedError = new Error(`[${context.path}] ${error.message}`);
      enhancedError.stack = error.stack;
      return enhancedError;
    }
  };
}
```

## Best Practices

### 1. Use TypeScript

Always develop plugins in TypeScript for better type safety:

```typescript
import type { Plugin, PluginContext } from '@schmock/core';

export function myPlugin(): Plugin {
  return {
    name: "my-plugin",
    version: "1.0.0",
    // Plugin implementation
  };
}
```

### 2. Handle Async Operations

Use promises for async operations:

```typescript
function asyncPlugin(): Plugin {
  return {
    name: "async-plugin",
    version: "1.0.0",
    
    async beforeRequest(context) {
      const data = await fetchUserData(context.headers.userId);
      context.state = { ...context.state, userData: data };
      return context;
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
    // Implementation
  };
}
```

### 4. Don't Mutate Original Context

Always return new objects or explicitly return the modified context:

```typescript
// Good
beforeRequest(context) {
  return {
    ...context,
    state: { ...context.state, timestamp: Date.now() }
  };
}

// Also good
beforeRequest(context) {
  context.state = { ...context.state, timestamp: Date.now() };
  return context;
}

// Bad - mutating without returning
beforeRequest(context) {
  context.state.timestamp = Date.now(); // Mutation without return
}
```

### 5. Use Meaningful Names and Versions

```typescript
function rateLimitPlugin(): Plugin {
  return {
    name: "rate-limiter",
    version: "2.1.0", // Follow semantic versioning
    // Implementation
  };
}
```

## Testing Plugins

Test your plugins thoroughly:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { myPlugin } from './my-plugin';

describe('MyPlugin', () => {
  it('should modify context correctly', async () => {
    const plugin = myPlugin();
    const context = {
      method: 'GET',
      path: '/test',
      params: {},
      query: {},
      headers: {},
      body: null,
      route: {},
      state: {}
    };
    
    const result = await plugin.beforeRequest!(context);
    
    expect(result).toBeDefined();
    expect(result.state).toHaveProperty('modified', true);
  });
});
```

## Publishing Plugins

When publishing plugins as npm packages:

1. Use the naming convention: `schmock-plugin-{name}`
2. Include proper TypeScript definitions
3. Add comprehensive documentation
4. Include usage examples
5. Follow semantic versioning

Example `package.json`:

```json
{
  "name": "schmock-plugin-auth",
  "version": "1.0.0",
  "description": "Authentication plugin for Schmock",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "keywords": ["schmock", "plugin", "auth", "mock"],
  "peerDependencies": {
    "@schmock/core": "^1.0.0"
  }
}
```