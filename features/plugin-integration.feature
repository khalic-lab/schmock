Feature: Plugin Pipeline Integration
  As a developer building complex applications
  I want to use plugins with the new pipeline architecture
  So that I can create extensible mock behaviors with clear data flow

  Scenario: Plugin state sharing with pipeline
    Given I create a mock with stateful plugin:
      """
      const mock = schmock({})
      mock('GET /counter', null, { contentType: 'application/json' })
        .pipe({
          name: "counter-plugin",
          process: (ctx, response) => {
            // Update shared route state
            ctx.routeState.request_count = (ctx.routeState.request_count || 0) + 1;
            
            // Generate response if none exists
            if (!response) {
              return {
                context: ctx,
                response: {
                  request_number: ctx.routeState.request_count,
                  path: ctx.path,
                  processed_at: new Date().toISOString()
                }
              };
            }
            
            // Pass through existing response
            return { context: ctx, response };
          }
        })
      """
    When I request "GET /counter" three times
    Then each response should have incrementing "request_number" values
    And each response should have a "processed_at" timestamp
    And the route state should persist across requests

  Scenario: Multiple plugins in pipeline
    Given I create a mock with multiple plugins:
      """
      const mock = schmock({})
      mock('GET /users', () => [{ id: 1, name: 'John' }], { contentType: 'application/json' })
        .pipe({
          name: "auth-plugin",
          process: (ctx, response) => {
            if (!ctx.headers.authorization) {
              throw new Error("Missing authorization");
            }
            ctx.state.set('user', { id: 1, name: 'Admin' });
            return { context: ctx, response };
          }
        })
        .pipe({
          name: "wrapper-plugin", 
          process: (ctx, response) => {
            if (response) {
              return {
                context: ctx,
                response: {
                  data: response,
                  meta: {
                    user: ctx.state.get('user'),
                    timestamp: "2025-01-31T10:15:30.123Z" // Fixed timestamp for test consistency
                  }
                }
              };
            }
            return { context: ctx, response };
          }
        })
      """
    When I request "GET /users" with headers:
      """
      { "authorization": "Bearer token123" }
      """
    Then I should receive:
      """
      {
        "data": [{ "id": 1, "name": "John" }],
        "meta": {
          "user": { "id": 1, "name": "Admin" },
          "timestamp": "2025-01-31T10:15:30.123Z"
        }
      }
      """

  Scenario: Plugin error handling
    Given I create a mock with error handling plugin:
      """
      const mock = schmock({})
      mock('GET /protected', () => ({ secret: 'data' }), { contentType: 'application/json' })
        .pipe({
          name: "auth-plugin",
          process: (ctx, response) => {
            if (!ctx.headers.authorization) {
              // Return error response directly instead of throwing
              return {
                context: ctx,
                response: [401, { error: "Unauthorized", code: "AUTH_REQUIRED" }]
              };
            }
            return { context: ctx, response };
          }
        })
      """
    When I request "GET /protected" without authorization
    Then the status should be 401
    And I should receive:
      """
      { "error": "Unauthorized", "code": "AUTH_REQUIRED" }
      """

  Scenario: Pipeline order and response transformation
    Given I create a mock with ordered plugins:
      """
      const mock = schmock({})
      mock('GET /data', () => ({ value: 42 }), { contentType: 'application/json' })
        .pipe({
          name: "step-1",
          process: (ctx, response) => {
            ctx.state.set('step1', 'processed');
            // Transform the response by adding step1 property
            if (response) {
              return {
                context: ctx,
                response: { ...response, step1: 'processed' }
              };
            }
            return { context: ctx, response };
          }
        })
        .pipe({
          name: "step-2", 
          process: (ctx, response) => {
            if (response) {
              return {
                context: ctx,
                response: { ...response, step2: 'processed' }
              };
            }
            return { context: ctx, response };
          }
        })
        .pipe({
          name: "step-3",
          process: (ctx, response) => {
            if (response) {
              return {
                context: ctx,
                response: { ...response, step3: 'processed' }
              };
            }
            return { context: ctx, response };
          }
        })
      """
    When I request "GET /data"
    Then I should receive:
      """
      {
        "value": 42,
        "step1": "processed",
        "step2": "processed", 
        "step3": "processed"
      }
      """

  Scenario: Schema plugin in pipeline
    Given I create a mock with schema plugin:
      """
      const mock = schmock({})
      mock('GET /users', (ctx) => {
        // Schema-based generator function
        const schema = {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              name: { type: 'string', faker: 'person.fullName' },
              email: { type: 'string', format: 'email' }
            }
          }
        };
        // Generate mock data from schema (simplified)
        return [
          { id: 1, name: "John Doe", email: "john@example.com" },
          { id: 2, name: "Jane Smith", email: "jane@example.com" }
        ];
      }, { contentType: 'application/json' })
        .pipe({
          name: "add-metadata",
          process: (ctx, response) => {
            if (response && Array.isArray(response)) {
              return {
                context: ctx,
                response: {
                  users: response,
                  count: response.length,
                  generated_at: new Date().toISOString()
                }
              };
            }
            return { context: ctx, response };
          }
        })
      """
    When I request "GET /users"
    Then the response should have a "users" array
    And the response should have a "count" field
    And the response should have a "generated_at" timestamp