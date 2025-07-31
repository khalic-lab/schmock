# Breaking Changes

This document tracks breaking changes across Schmock versions to help users upgrade their implementations.

## Version 1.0.0 (Current)

### Plugin System Overhaul

**Breaking Change**: Complete rewrite of the plugin system with new lifecycle hooks.

**Before (v0.x)**:
```typescript
interface Plugin {
  name: string;
  version: string;
  generate?(context: PluginContext): any;
  transform?(data: any, context: PluginContext): any;
}
```

**After (v1.0.0)**:
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

**Migration**:
- Existing `generate` and `transform` methods remain compatible
- Add new lifecycle hooks as needed for enhanced functionality
- Use `enforce: "pre"` or `enforce: "post"` to control plugin execution order

### Enhanced Plugin Context

**Breaking Change**: `PluginContext` now includes full request details.

**Before (v0.x)**:
```typescript
interface PluginContext {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  route: Route;
  state: any;
}
```

**After (v1.0.0)**:
```typescript
interface PluginContext {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;    // NEW
  headers: Record<string, string>;  // NEW
  body: any;                        // NEW
  route: Route;
  state: any;
}
```

**Migration**:
- Update plugins that access context to handle new properties
- No breaking changes for existing property access

### Express Adapter Enhancements

**Breaking Change**: `toExpress` function signature updated with options parameter.

**Before (v0.x)**:
```typescript
toExpress(mock: MockInstance): RequestHandler
```

**After (v1.0.0)**:
```typescript
toExpress(mock: MockInstance, options?: ExpressAdapterOptions): RequestHandler
```

**Migration**:
- Existing usage remains compatible (options parameter is optional)
- Add options for enhanced functionality like custom error handling

### Angular Adapter Introduction

**New Feature**: Added `@schmock/angular` package with HTTP interceptor support.

**Usage**:
```typescript
import { createSchmockInterceptor, provideSchmockInterceptor } from '@schmock/angular';

// Create interceptor class
const InterceptorClass = createSchmockInterceptor(mockInstance, options);

// Or use provider
const provider = provideSchmockInterceptor(mockInstance, options);
```

### Schema Plugin Improvements

**Breaking Change**: Enhanced error handling with specific error types.

**Before (v0.x)**:
- Generic Error objects thrown for all schema issues

**After (v1.0.0)**:
```typescript
// Specific error types
throw new SchemaValidationError(path, message, suggestion?);
throw new SchemaGenerationError(path, originalError, schema);
throw new ResourceLimitError(limitType, limit, actual);
```

**Migration**:
- Update error handling code to catch specific error types
- Generic Error catching still works but provides less detail

### TypeScript Improvements

**Breaking Change**: Stricter TypeScript definitions and better type safety.

**Changes**:
- More precise type definitions for plugin hooks
- Better inference for response types
- Stricter validation of plugin configurations

**Migration**:
- Fix any TypeScript compilation errors that arise
- Update plugin type annotations as needed

## Upgrade Guide

### From v0.x to v1.0.0

1. **Update Dependencies**:
   ```bash
   npm install @schmock/builder@^1.0.0
   npm install @schmock/express@^1.0.0
   npm install @schmock/schema@^1.0.0
   # Optional: npm install @schmock/angular@^1.0.0
   ```

2. **Update Plugin Implementations**:
   ```typescript
   // Before
   const myPlugin: Plugin = {
     name: "my-plugin",
     version: "1.0.0",
     generate(context) {
       // Implementation
     }
   };

   // After (enhanced with new hooks)
   const myPlugin: Plugin = {
     name: "my-plugin",
     version: "1.0.0",
     beforeRequest(context) {
       // New: modify request before processing
       return context;
     },
     generate(context) {
       // Existing implementation works unchanged
     },
     afterGenerate(data, context) {
       // New: post-process generated data
       return data;
     }
   };
   ```

3. **Update Error Handling**:
   ```typescript
   // Before
   try {
     await mock.handle('GET', '/api/users');
   } catch (error) {
     console.error('Error:', error.message);
   }

   // After (with specific error types)
   try {
     await mock.handle('GET', '/api/users');
   } catch (error) {
     if (error instanceof SchemaValidationError) {
       console.error('Schema validation failed:', error.path, error.message);
     } else if (error instanceof ResourceLimitError) {
       console.error('Resource limit exceeded:', error.limitType, error.actual);
     } else {
       console.error('General error:', error.message);
     }
   }
   ```

4. **Update Express Integration** (if using custom options):
   ```typescript
   // Before
   app.use('/api', toExpress(mock));

   // After (with enhanced options)
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

5. **Test Your Implementation**:
   - Run your test suite to ensure compatibility
   - Test plugin execution order with new `enforce` property
   - Verify error handling works with new error types
   - Check that all lifecycle hooks execute as expected

## Deprecated Features

### v1.0.0

- **None currently**: This is the initial stable release

## Future Breaking Changes

### Planned for v2.0.0

- **Plugin Registration**: May change from method chaining to configuration object
- **Response Format**: May standardize response object structure
- **TypeScript**: May require TypeScript 5.0+ for better type inference

**Note**: These are tentative and subject to change based on community feedback.

## Support

If you encounter issues upgrading:

1. Check the [plugin development guide](./plugin-development.md)
2. Review the [API documentation](./api.md)
3. Look at the examples in `/features/*.feature` files
4. Open an issue on GitHub with your specific use case

## Compatibility Matrix

| Schmock Version | Node.js | TypeScript | Express | Angular |
|----------------|---------|------------|---------|---------|
| 1.0.0          | >=16    | >=4.5      | >=4.0   | >=15    |
| 0.x            | >=14    | >=4.0      | >=4.0   | N/A     |