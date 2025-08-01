Feature: Performance and Reliability E2E
  As a developer deploying mock services
  I want reliable performance under various conditions
  So that my mocks can handle production-like scenarios

  Scenario: High-volume concurrent requests
    Given I create a mock for load testing:
      """
      schmock()
        .routes({
          'GET /api/health': {
            response: () => ({ status: 'healthy', timestamp: Date.now() })
          },
          'GET /api/data/:id': {
            response: ({ params }) => ({
              id: params.id,
              data: Array.from({ length: 50 }, (_, i) => ({ 
                index: i, 
                value: Math.random() 
              })),
              generated_at: new Date().toISOString()
            })
          },
          'POST /api/process': {
            response: ({ body }) => {
              // Simulate processing time
              const items = Array.isArray(body) ? body : [body];
              return {
                processed: items.length,
                results: items.map(item => ({ ...item, processed: true })),
                batch_id: Math.random().toString(36)
              };
            }
          }
        })
      """
    When I send 100 concurrent "GET /api/health" requests
    Then all concurrent requests should complete successfully
    And the average response time should be under 50ms
    And no requests should timeout
    When I send 50 concurrent requests to different "/api/data/:id" endpoints
    Then all responses should be unique based on ID
    And each response should contain 50 data items
    When I send 25 concurrent "POST /api/process" requests with different payloads
    And all concurrent requests should complete successfully
    And each response should have a unique batch_id

  Scenario: Memory usage under sustained load
    Given I create a mock with potential memory concerns:
      """
      schmock()
        .routes({
          'POST /api/large-data': {
            response: ({ body }) => {
              // Create large response data
              const largeArray = Array.from({ length: 1000 }, (_, i) => ({
                id: i,
                data: 'x'.repeat(100), // 100 chars per item
                timestamp: Date.now(),
                random: Math.random()
              }));
              
              return {
                items: largeArray,
                count: largeArray.length,
                size: 'large',
                request_data: body
              };
            }
          },
          'GET /api/accumulate/:count': {
            response: ({ params }) => {
              const count = parseInt(params.count) || 100;
              const accumulated = [];
              
              for (let i = 0; i < count; i++) {
                accumulated.push({
                  iteration: i,
                  data: `item-${i}`,
                  nested: {
                    level1: { level2: { level3: `deep-${i}` } }
                  }
                });
              }
              
              return { accumulated, total: count };
            }
          }
        })
      """
    When I send 20 requests to "POST /api/large-data" with 100KB payloads
    Then all requests should complete without memory errors
    And the mock should handle the load gracefully
    When I request "GET /api/accumulate/500" multiple times
    Then each response should contain 500 accumulated items
    And the memory usage should remain stable

  Scenario: Error resilience and recovery
    Given I create a mock with intermittent failures:
      """
      schmock()
        .state({ requestCount: 0, errorRate: 0.2 })
        .routes({
          'GET /api/flaky': {
            response: ({ state }) => {
              state.requestCount++;
              
              // Simulate intermittent failures
              if (Math.random() < state.errorRate) {
                const errorTypes = [
                  [500, { error: 'Internal server error', code: 'INTERNAL' }],
                  [503, { error: 'Service unavailable', code: 'UNAVAILABLE' }],
                  [429, { error: 'Rate limit exceeded', code: 'RATE_LIMIT' }]
                ];
                
                const errorType = errorTypes[Math.floor(Math.random() * errorTypes.length)];
                return errorType;
              }
              
              return {
                success: true,
                request_number: state.requestCount,
                timestamp: Date.now()
              };
            }
          },
          'POST /api/validate-strict': {
            response: ({ body, headers }) => {
              if (!headers['content-type']) {
                return [400, { error: 'Content-Type header required' }];
              }
              
              if (!body) {
                return [400, { error: 'Request body required' }];
              }
              
              if (typeof body !== 'object') {
                return [400, { error: 'Body must be JSON object' }];
              }
              
              if (!body.required_field) {
                return [422, { 
                  error: 'Validation failed',
                  missing: ['required_field']
                }];
              }
              
              return { validated: true, data: body };
            }
          }
        })
      """
    When I send 50 requests to "GET /api/flaky"
    Then some requests should succeed and some should fail
    And the success rate should be approximately 80%
    And error responses should have appropriate status codes
    When I send requests to "POST /api/validate-strict" with various invalid inputs
    Then each error should have a specific, helpful error message
    And the error codes should correctly identify the validation issue

  Scenario: Route matching performance with complex patterns
    Given I create a mock with many route patterns:
      """
      schmock()
        .routes({
          'GET /api/users': { response: () => ({ type: 'users-list' }) },
          'GET /api/users/:id': { response: ({ params }) => ({ type: 'user', id: params.id }) },
          'GET /api/users/:id/posts': { response: ({ params }) => ({ type: 'user-posts', userId: params.id }) },
          'GET /api/users/:id/posts/:postId': { response: ({ params }) => ({ type: 'user-post', userId: params.id, postId: params.postId }) },
          'GET /api/users/:id/posts/:postId/comments': { response: ({ params }) => ({ type: 'post-comments', userId: params.id, postId: params.postId }) },
          'GET /api/posts': { response: () => ({ type: 'posts-list' }) },
          'GET /api/posts/:id': { response: ({ params }) => ({ type: 'post', id: params.id }) },
          'GET /api/posts/:id/comments/:commentId': { response: ({ params }) => ({ type: 'comment', postId: params.id, commentId: params.commentId }) },
          'GET /static/:category/:file': { response: ({ params }) => ({ type: 'static', category: params.category, file: params.file }) },
          'GET /api/:version/users/:id': { response: ({ params }) => ({ type: 'versioned-user', version: params.version, id: params.id }) }
        })
      """
    When I send requests to all route patterns simultaneously
    Then each request should match the correct route pattern
    And parameter extraction should work correctly for all patterns
    And the route matching should be efficient even with many patterns
    When I send requests to non-matching paths
    Then they should consistently return 404 responses
    And the 404 responses should be fast

