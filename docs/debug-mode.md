# Debug Mode

Schmock includes a comprehensive debug mode that provides detailed logging throughout the request processing lifecycle. This is extremely useful for development, troubleshooting, and understanding how your mocks and plugin pipelines are working.

## Enabling Debug Mode

Debug mode can be enabled through the global configuration when creating your Schmock instance:

```typescript
import { schmock } from '@schmock/core';

// Enable debug mode globally
const mock = schmock({ debug: true });

mock('GET /users', () => [{ id: 1, name: 'John' }], { 
  contentType: 'application/json' 
});
```

## Debug Output

When debug mode is enabled, you'll see detailed console output showing:

### Instance Creation
```
[2025-01-31T10:15:30.100Z] [SCHMOCK:CONFIG] Debug mode enabled
[2025-01-31T10:15:30.101Z] [SCHMOCK:INSTANCE] SchmockInstance created {
  routeCount: 0,
  pluginCount: 0,
  debugEnabled: true
}
```

### Route Definition
```
[2025-01-31T10:15:30.110Z] [SCHMOCK:ROUTE] Route defined: GET /users
[2025-01-31T10:15:30.111Z] [SCHMOCK:PLUGIN] Registered plugin: auth@1.0.0 {
  name: 'auth',
  version: '1.0.0',
  hasProcess: true,
  hasOnError: true
}
```

### Request Processing
```
[2025-01-31T10:15:30.123Z] [SCHMOCK:REQUEST] [abc123] GET /users {
  headers: { 'user-agent': 'test' },
  query: { limit: '10' },
  bodyType: 'none'
}
```

### Route Matching
```
[2025-01-31T10:15:30.125Z] [SCHMOCK:ROUTE] [abc123] Matched route: /users
```

### Plugin Pipeline Execution
```
[2025-01-31T10:15:30.126Z] [SCHMOCK:PIPELINE] Running plugin pipeline for 3 plugins
[2025-01-31T10:15:30.127Z] [SCHMOCK:PIPELINE] Processing plugin: auth
[2025-01-31T10:15:30.128Z] [SCHMOCK:PIPELINE] Processing plugin: schema-generator
[2025-01-31T10:15:30.130Z] [SCHMOCK:PIPELINE] Plugin schema-generator generated response
[2025-01-31T10:15:30.131Z] [SCHMOCK:PIPELINE] Processing plugin: cors
[2025-01-31T10:15:30.132Z] [SCHMOCK:PIPELINE] Plugin cors transformed response
```

### Response Processing
```
[2025-01-31T10:15:30.140Z] [SCHMOCK:RESPONSE] [abc123] Sending response 200 {
  status: 200,
  headers: { 'content-type': 'application/json' },
  bodyType: 'object'
}
[SCHMOCK] request-abc123: 25.678ms
```

### Error Handling
```
[2025-01-31T10:15:30.150Z] [SCHMOCK:ERROR] [def456] Error processing request: Authentication required
[2025-01-31T10:15:30.151Z] [SCHMOCK:PIPELINE] Plugin auth failed: Authentication required
[2025-01-31T10:15:30.152Z] [SCHMOCK:PIPELINE] Plugin auth handled error
[2025-01-31T10:15:30.153Z] [SCHMOCK:ERROR] [def456] Returning error response 500
[SCHMOCK] request-def456: 15.234ms
```

## Log Categories

Debug logs are categorized for easy filtering:

- **`CONFIG`**: Configuration changes and debug mode activation
- **`PLUGIN`**: Plugin registration and management
- **`INSTANCE`**: Instance creation and initialization
- **`REQUEST`**: Request processing start and details
- **`ROUTE`**: Route matching, selection, and definition
- **`PIPELINE`**: Plugin pipeline execution and processing
- **`RESPONSE`**: Successful response generation
- **`ERROR`**: Error handling and processing

## Filtering Debug Output

You can filter debug output in your console or logging system by searching for specific categories:

```bash
# Filter for only plugin-related logs
npm start | grep "SCHMOCK:PLUGIN"

# Filter for pipeline execution
npm start | grep "SCHMOCK:PIPELINE"

# Filter for errors only
npm start | grep "SCHMOCK:ERROR"

# Filter for a specific request ID
npm start | grep "abc123"
```

## Performance Timing

Debug mode includes automatic performance timing for each request:

```
[SCHMOCK] request-abc123: 25.678ms
[SCHMOCK] build: 5.123ms
```

This helps identify performance bottlenecks in your mock setup or plugin execution.

## Production Usage

**Important**: Debug mode should be disabled in production environments as it:

- Generates verbose console output
- Adds overhead to request processing
- May expose sensitive request/response details

```typescript
// Environment-based debug mode
const mock = schmock({
  debug: process.env.NODE_ENV === 'development'
});
```

## Advanced Debug Setup

### Custom Debug Logging

You can combine debug mode with your own logging system:

```typescript
// Capture debug output
const originalConsoleLog = console.log;
const debugLogs: string[] = [];

console.log = (...args) => {
  if (args[0]?.includes('[SCHMOCK:')) {
    debugLogs.push(args.join(' '));
  }
  originalConsoleLog(...args);
};

const mock = schmock({ debug: true });

// Later: analyze collected debug logs
console.log('Collected debug logs:', debugLogs);
```

### Conditional Debug Mode

Enable debug mode based on specific conditions:

```typescript
const mock = schmock({
  debug: process.env.DEBUG_SCHMOCK === 'true' || 
         process.env.NODE_ENV === 'test'
});
```

### Debug Mode with Testing

Debug mode is particularly useful during testing to understand why mocks behave unexpectedly:

```typescript
describe('API Integration', () => {
  let mock: CallableMockInstance;

  beforeEach(() => {
    mock = schmock({ debug: true });  // Enable for test debugging
    mock('GET /users', () => users, { contentType: 'application/json' });
  });

  it('should return users', async () => {
    // Debug output will show the complete request/response cycle
    const response = await mock.handle('GET', '/users');
    expect(response.status).toBe(200);
  });
});
```

## Troubleshooting Common Issues

### Plugin Not Executing
Look for plugin registration logs:
```
[SCHMOCK:PLUGIN] Registered plugin: my-plugin@1.0.0
```

If missing, check your `.pipe()` calls.

### Route Not Matching
Check route matching logs:
```
[SCHMOCK:ROUTE] [abc123] No route found for GET /wrong-path
```

Verify your route patterns and ensure you're calling the mock instance correctly.

### Plugin Pipeline Errors
Plugin failures are clearly logged:
```
[SCHMOCK:PIPELINE] Plugin my-plugin failed: Cannot read property 'id' of undefined
```

Check your plugin's `process()` method implementation.

### Performance Issues
Use timing logs to identify slow operations:
```
[SCHMOCK] request-abc123: 250.678ms  // This is slow!
```

Look for plugins or operations taking excessive time.

## Best Practices

1. **Enable During Development**: Always use debug mode during development and testing
2. **Disable in Production**: Turn off debug mode in production environments
3. **Use Environment Variables**: Control debug mode through environment configuration
4. **Filter Output**: Use log filtering to focus on specific issues
5. **Monitor Performance**: Use timing information to optimize plugin performance
6. **Save Debug Logs**: Consider saving debug output for later analysis in complex scenarios

## Development Workflow Integration

Debug mode works seamlessly with Schmock's development tools:

### Automated Testing
```typescript
// Debug mode is automatically enabled in BDD tests
describe('Mock behavior', () => {
  it('should handle requests correctly', async () => {
    const mock = schmock({ debug: true }); // Debug output in test logs
    // ... test implementation
  });
});
```

### Git Hooks Integration
When using `bun run setup` to configure Git hooks:
- Pre-commit hooks run all 262 tests (101 unit + 161 BDD)
- Debug output helps identify issues during automated testing
- Type checking ensures debug mode configuration is correct

### Quality Assurance
- **Linting**: Automated linting catches debug configuration issues
- **Type Safety**: TypeScript ensures proper debug mode usage
- **Comprehensive Testing**: BDD tests validate debug output functionality

Debug mode is one of Schmock's most powerful features for understanding and troubleshooting your mock implementations. Use it liberally during development to build confidence in your mock behavior.