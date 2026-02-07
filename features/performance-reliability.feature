Feature: Performance and Reliability E2E
  As a developer deploying mock services
  I want reliable performance under various conditions
  So that my mocks can handle production-like scenarios

  Scenario: High-volume concurrent requests
    Given I create a mock for high-volume load testing
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
    Given I create a mock with large payload handling
    When I send 20 requests to "POST /api/large-data" with 100KB payloads
    Then all requests should complete without memory errors
    And the mock should handle the load gracefully
    When I request "GET /api/accumulate/500" multiple times
    Then each response should contain 500 accumulated items
    And the memory usage should remain stable

  Scenario: Error resilience and recovery
    Given I create a mock with intermittent failure simulation
    When I send 50 requests to "GET /api/flaky"
    Then some requests should succeed and some should fail
    And the success rate should be approximately 80%
    And error responses should have appropriate status codes
    When I send requests to "POST /api/validate-strict" with various invalid inputs
    Then each error should have a specific, helpful error message
    And the error codes should correctly identify the validation issue

  Scenario: Route matching performance with complex patterns
    Given I create a mock with many nested route patterns
    When I send requests to all route patterns simultaneously
    Then each request should match the correct route pattern
    And parameter extraction should work correctly for all patterns
    When I send requests to non-matching paths
    Then they should consistently return 404 responses
