# Phase 2: Plugin System Enhancement - Detailed Plan

## Overview

Phase 2 focuses on completing the schema plugin integration and establishing a robust plugin system that enables extensibility while maintaining type safety and error handling.

## Current State Analysis

### What's Working
- Plugin architecture is restored and functional
- Plugins can generate data when routes lack response functions
- Error wrapping and event emission for plugin lifecycle
- Schema plugin generates data for valid schemas

### What Needs Improvement
- Schema validation is too permissive (accepts malformed schemas)
- Error handling doesn't match BDD test expectations
- Plugin hooks are limited to `generate` method only
- No mechanism for plugins to enhance response context
- Type safety gaps in plugin interfaces

## Detailed Implementation Plan

### 2.1 Schema Plugin Error Handling

#### 2.1.1 Strict Schema Validation
```typescript
// Add to schema plugin before generation:
- Validate schema structure (properties must be objects)
- Check for unsupported schema features early
- Validate circular references before generation
- Enforce resource limits (max depth, array size)
```

#### 2.1.2 Error Integration
- Convert schema validation errors to `SchmockError` subclasses
- Add new error types:
  - `SchemaValidationError` - For invalid schema structure
  - `SchemaGenerationError` - For generation failures
  - `ResourceLimitError` - For exceeding limits
- Ensure all errors bubble up with proper status codes

#### 2.1.3 Test-Driven Fixes
Fix each failing BDD scenario:
1. Invalid JSON schema type → Validate supported types
2. Malformed schema structure → Check properties format
3. Circular references → Detect and reject
4. Resource limits → Enforce max depth/array size
5. Template errors → Validate template syntax

### 2.2 Enhanced Plugin Lifecycle

#### 2.2.1 New Plugin Hooks
```typescript
interface Plugin {
  // Initialization
  setup?(core: Core): void | Promise<void>;
  
  // Request lifecycle
  beforeRequest?(context: RequestContext): void | Promise<void>;
  beforeGenerate?(context: PluginContext): any | void | Promise<any | void>;
  generate?(context: PluginContext): any | void | Promise<any | void>;
  afterGenerate?(data: any, context: PluginContext): any | Promise<any>;
  beforeResponse?(response: Response, context: PluginContext): void | Promise<void>;
  
  // Error handling
  onError?(error: Error, context: PluginContext): Error | void;
}
```

#### 2.2.2 Plugin Context Enhancement
```typescript
interface PluginContext {
  // Existing
  path: string;
  route: Route;
  method?: string;
  params?: Record<string, string>;
  state: Map<string, any>;
  
  // New additions
  request: Request;
  core: Core;
  emit: (event: string, data: any) => void;
  getPlugin: (name: string) => Plugin | undefined;
}
```

#### 2.2.3 Plugin Ordering
- Add `order` property to plugins (default: 0)
- Sort plugins by order before execution
- Add `enforce: 'pre' | 'post'` for guaranteed positioning
- Enable plugin dependencies declaration

### 2.3 Builder-Plugin Integration

#### 2.3.1 Route Definition Extensions
```typescript
interface RouteDefinition {
  response?: ResponseFunction;
  
  // Plugin extensions
  schema?: JSONSchema7;
  validate?: ValidationRules;
  transform?: TransformFunction;
  cache?: CacheOptions;
  [pluginName: string]: any; // Allow plugin-specific options
}
```

#### 2.3.2 Context Enhancement for Routes
- Allow plugins to inject helpers into response context
- Example: `context.generateFromSchema()` for schema plugin
- Maintain type safety with declaration merging

#### 2.3.3 Plugin Registration Improvements
```typescript
// Support plugin options
.use(schemaPlugin({ 
  strict: true,
  maxDepth: 10,
  maxArraySize: 1000 
}))

// Support multiple plugins in one call
.use([schemaPlugin(), validationPlugin(), cachePlugin()])
```

### 2.4 Schema Plugin Specific Improvements

#### 2.4.1 Validation Rules
```typescript
const validationRules = {
  schemaTypes: ['object', 'array', 'string', 'number', 'boolean', 'null'],
  maxNestingDepth: 10,
  maxArraySize: 10000,
  maxStringLength: 10000,
  forbiddenProperties: ['$ref', 'definitions'], // For now
};
```

#### 2.4.2 Better Error Messages
```typescript
class SchemaValidationError extends SchmockError {
  constructor(
    schemaPath: string,
    issue: string,
    suggestion?: string
  ) {
    super(
      `Schema validation failed at ${schemaPath}: ${issue}${suggestion ? `. ${suggestion}` : ''}`,
      'SCHEMA_VALIDATION_ERROR',
      { schemaPath, issue, suggestion }
    );
  }
}
```

#### 2.4.3 Template Processing Improvements
- Validate template syntax before processing
- Support nested property access safely
- Handle undefined values gracefully
- Preserve original on template errors

## Implementation Steps

### Step 1: Create Schema Error Classes (Day 1 Morning)
1. Add new error classes to `packages/builder/src/errors.ts`
2. Update schema plugin to use typed errors
3. Run tests to verify error propagation

### Step 2: Implement Strict Schema Validation (Day 1 Afternoon)
1. Add validation before `jsf.generate()`
2. Check schema structure recursively
3. Validate against resource limits
4. Fix failing BDD tests one by one

### Step 3: Enhance Plugin Lifecycle (Day 2 Morning)
1. Update Plugin interface in types
2. Implement hook execution in builder
3. Add plugin ordering logic
4. Test with multiple plugins

### Step 4: Integrate Schema Plugin Properly (Day 2 Afternoon)
1. Move schema plugin to use new hooks
2. Add context enhancement for routes
3. Implement `generateFromSchema` helper
4. Ensure all BDD tests pass

### Step 5: Documentation and Examples (Day 3)
1. Update type definitions
2. Create plugin development guide
3. Add examples for common patterns
4. Document breaking changes

## Testing Strategy

### Unit Tests
- Test each error class individually
- Test schema validation rules
- Test plugin ordering logic
- Test context enhancement

### Integration Tests
- Test plugin interaction
- Test error propagation through stack
- Test with multiple plugins

### BDD Tests
- All existing tests should pass
- Add new tests for plugin features
- Test edge cases discovered

## Success Criteria

1. **All BDD tests passing** (currently 45 failing)
2. **Type-safe plugin system** with proper interfaces
3. **Comprehensive error handling** with actionable messages
4. **Plugin lifecycle hooks** working correctly
5. **Schema validation** catching all malformed inputs
6. **Documentation** for plugin developers

## Risk Mitigation

### Performance Impact
- Cache validated schemas
- Lazy load plugins
- Profile hot paths

### Breaking Changes
- Maintain backward compatibility where possible
- Clear migration path for plugin API changes
- Deprecation warnings before removal

### Type Safety
- Use strict TypeScript settings
- No `any` types in public APIs
- Runtime validation matches types

## Next Steps After Phase 2

1. **Phase 3**: Framework adapters (Express, Angular)
2. **Phase 4**: Documentation and polish
3. **Future**: Additional plugins (validation, caching, auth)

## Timeline

- **Day 1**: Error handling and schema validation
- **Day 2**: Plugin lifecycle and integration
- **Day 3**: Testing, documentation, and polish

Total estimated time: 3 days