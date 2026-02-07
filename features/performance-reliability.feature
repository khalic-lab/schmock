Feature: Performance and Reliability E2E
  As a developer deploying mock services
  I want reliable performance under various conditions
  So that my mocks can handle production-like scenarios

  Scenario: High-volume concurrent requests
    Given I create a mock for load testing:
      """
      const mock = schmock()
      mock('GET /api/health', () => ({
        status: 'healthy',
        timestamp: Date.now()
      }))
      mock('GET /api/data/:id', ({ params }) => ({
        id: params.id,
        data: Array.from({ length: 50 }, (_, i) => ({
          index: i,
          value: Math.random()
        })),
        generated_at: new Date().toISOString()
      }))
      mock('POST /api/process', ({ body }) => {
        const items = Array.isArray(body) ? body : [body]
        return {
          processed: items.length,
          results: items.map(item => ({ ...item, processed: true })),
          batch_id: Math.random().toString(36)
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
      const mock = schmock()
      mock('POST /api/large-data', ({ body }) => {
        const largeArray = Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          data: 'x'.repeat(100),
          timestamp: Date.now(),
          payload: body
        }))
        return {
          results: largeArray,
          items: largeArray,
          total_size: largeArray.length,
          size: 'large',
          memory_usage: process.memoryUsage ? process.memoryUsage() : null
        }
      })
      mock('GET /api/accumulate/:count', ({ params }) => {
        const count = parseInt(params.count)
        const items = Array.from({ length: count }, (_, i) => ({
          id: i,
          value: Math.random(),
          timestamp: Date.now()
        }))
        return {
          items: items,
          accumulated: items,
          total: items.length,
          count: items.length,
          memory_usage: process.memoryUsage ? process.memoryUsage() : null
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
      const mock = schmock()
      let requestCount = 0
      mock('POST /api/unreliable', ({ body }) => {
        requestCount++
        if (requestCount % 5 === 0) {
          return [500, { error: 'Simulated server error', request_id: requestCount }]
        }
        return [200, { success: true, data: body, request_id: requestCount }]
      })
      mock('GET /api/flaky', () => {
        requestCount++
        if (requestCount % 5 === 0) {
          return [500, { error: 'Flaky service error', request_id: requestCount }]
        }
        return [200, { success: true, request_id: requestCount }]
      })
      mock('POST /api/validate-strict', ({ body }) => {
        if (!body || typeof body !== 'object') {
          return [400, { error: 'Request body is required and must be an object', code: 'INVALID_BODY' }]
        }
        if (!body.name || typeof body.name !== 'string') {
          return [422, { error: 'Name field is required and must be a string', code: 'INVALID_NAME' }]
        }
        if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
          return [422, { error: 'Valid email address is required', code: 'INVALID_EMAIL' }]
        }
        return [200, { message: 'Validation successful', data: body }]
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
      const mock = schmock()
      mock('GET /api/users', () => ({ type: 'users-list' }))
      mock('GET /api/users/:id', ({ params }) => ({ type: 'user', id: params.id }))
      mock('GET /api/users/:userId/posts', ({ params }) => ({ type: 'user-posts', userId: params.userId }))
      mock('GET /api/users/:userId/posts/:postId', ({ params }) => ({
        type: 'user-post',
        userId: params.userId,
        postId: params.postId
      }))
      mock('GET /api/users/:userId/posts/:postId/comments', ({ params }) => ({
        type: 'post-comments',
        userId: params.userId,
        postId: params.postId
      }))
      mock('GET /api/posts', () => ({ type: 'posts-list' }))
      mock('GET /api/posts/:postId', ({ params }) => ({ type: 'post', postId: params.postId }))
      mock('GET /api/posts/:postId/comments/:commentId', ({ params }) => ({
        type: 'comment',
        postId: params.postId,
        commentId: params.commentId
      }))
      mock('GET /static/:category/:file', ({ params }) => ({
        type: 'static',
        category: params.category,
        file: params.file
      }))
      mock('GET /api/v2/users/:userId', ({ params }) => ({
        type: 'versioned-user',
        userId: params.userId,
        version: 'v2'
      }))
      """
    When I send requests to all route patterns simultaneously
    Then each request should match the correct route pattern
    And parameter extraction should work correctly for all patterns
    When I send requests to non-matching paths
    Then they should consistently return 404 responses
