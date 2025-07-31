# Debug Mode

Schmock includes a comprehensive debug mode that provides detailed logging throughout the request processing lifecycle. This is extremely useful for development, troubleshooting, and understanding how your mocks are working.

## Enabling Debug Mode

Debug mode can be enabled through the `config()` method when building your Schmock instance:

```typescript
import { schmock } from '@schmock/builder';

const mock = schmock()
  .config({ debug: true })
  .get('/api/users', { data: [{ id: 1, name: 'John' }] })
  .build();
```

## Debug Output

When debug mode is enabled, you'll see detailed console output showing:

### Request Processing
```
[2025-01-31T10:15:30.123Z] [SCHMOCK:REQUEST] [abc123] GET /api/users {
  headers: { 'user-agent': 'test' },
  query: { limit: '10' },
  bodyType: 'none'
}
```

### Route Matching
```
[2025-01-31T10:15:30.125Z] [SCHMOCK:ROUTE] [abc123] Matched route: GET /api/users
```

### Plugin Execution
```
[2025-01-31T10:15:30.126Z] [SCHMOCK:HOOKS] Running beforeRequest hooks for 2 plugins
[2025-01-31T10:15:30.127Z] [SCHMOCK:HOOKS] Executing beforeRequest: auth-plugin
[2025-01-31T10:15:30.128Z] [SCHMOCK:HOOKS] Plugin auth-plugin modified context
[2025-01-31T10:15:30.129Z] [SCHMOCK:HOOKS] Executing beforeRequest: logging-plugin
```

### Data Generation
```
[2025-01-31T10:15:30.130Z] [SCHMOCK:HOOKS] Running beforeGenerate hooks for 1 plugins
[2025-01-31T10:15:30.131Z] [SCHMOCK:HOOKS] Executing beforeGenerate: schema-plugin
[2025-01-31T10:15:30.135Z] [SCHMOCK:HOOKS] Plugin schema-plugin returned early response
```

### Response Processing
```
[2025-01-31T10:15:30.140Z] [SCHMOCK:HOOKS] Running beforeResponse hooks for 1 plugins
[2025-01-31T10:15:30.141Z] [SCHMOCK:HOOKS] Executing beforeResponse: cors-plugin
[2025-01-31T10:15:30.142Z] [SCHMOCK:HOOKS] Plugin cors-plugin modified response
[2025-01-31T10:15:30.143Z] [SCHMOCK:RESPONSE] [abc123] Sending response 200 {
  status: 200,
  headers: { 'content-type': 'application/json' },
  bodyType: 'object'
}
[SCHMOCK] request-abc123: 25.678ms
```

### Error Handling
```
[2025-01-31T10:15:30.150Z] [SCHMOCK:ERROR] [def456] Error processing request: Schema validation failed
[2025-01-31T10:15:30.151Z] [SCHMOCK:HOOKS] Running onError hooks for 1 plugins
[2025-01-31T10:15:30.152Z] [SCHMOCK:HOOKS] Executing onError: error-handler
[2025-01-31T10:15:30.153Z] [SCHMOCK:HOOKS] Plugin error-handler handled error
[2025-01-31T10:15:30.154Z] [SCHMOCK:ERROR] [def456] Plugin handled error with response 400
[SCHMOCK] request-def456: 15.234ms
```

## Log Categories

Debug logs are categorized for easy filtering:

- **`CONFIG`**: Configuration changes and debug mode activation
- **`PLUGIN`**: Plugin registration and management
- **`BUILD`**: Instance building and compilation
- **`INSTANCE`**: Instance creation and initialization
- **`REQUEST`**: Request processing start and details
- **`ROUTE`**: Route matching and selection
- **`HOOKS`**: Plugin lifecycle hook execution
- **`RESPONSE`**: Successful response generation
- **`ERROR`**: Error handling and processing

## Filtering Debug Output

You can filter debug output in your console or logging system by searching for specific categories:

```bash
# Filter for only plugin-related logs
npm start | grep "SCHMOCK:PLUGIN"

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
const mock = schmock()
  .config({
    debug: process.env.NODE_ENV === 'development'
  })
  .build();
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

const mock = schmock()
  .config({ debug: true })
  .build();

// Later: analyze collected debug logs
console.log('Collected debug logs:', debugLogs);
```

### Conditional Debug Mode

Enable debug mode based on specific conditions:

```typescript
const mock = schmock()
  .config({
    debug: process.env.DEBUG_SCHMOCK === 'true' || 
           process.env.NODE_ENV === 'test'
  })
  .build();
```

### Debug Mode with Testing

Debug mode is particularly useful during testing to understand why mocks behave unexpectedly:

```typescript
describe('API Integration', () => {
  let mock: MockInstance;

  beforeEach(() => {
    mock = schmock()
      .config({ debug: true })  // Enable for test debugging
      .get('/api/users', { data: users })
      .build();
  });

  it('should return users', async () => {
    // Debug output will show the complete request/response cycle
    const response = await mock.handle('GET', '/api/users');
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

If missing, check your plugin registration.

### Route Not Matching
Check route matching logs:
```
[SCHMOCK:ROUTE] [abc123] No route found for GET /api/wrong-path
```

Verify your route patterns.

### Plugin Errors
Plugin failures are clearly logged:
```
[SCHMOCK:HOOKS] Plugin my-plugin beforeRequest failed: Cannot read property 'id' of undefined
```

Check your plugin implementation.

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

Debug mode is one of Schmock's most powerful features for understanding and troubleshooting your mock implementations. Use it liberally during development to build confidence in your mock behavior.