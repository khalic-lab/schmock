Feature: Async Support
  As a developer using Schmock
  I want full support for async/Promise-based operations
  So that I can create realistic mocks for async APIs and workflows

  Scenario: Async generator function returns Promise
    Given I create a mock with an async generator at "GET /async-data"
    When I request "GET /async-data"
    Then I should receive:
      """
      { "message": "async response" }
      """
    And the content-type should be "application/json"

  Scenario: Async generator with context access
    Given I create a mock with an async param-based generator at "GET /async-user/:id"
    When I request "GET /async-user/123"
    Then the response should have property "userId" with value "123"
    And the response should have property "fetchedAt"

  Scenario: Multiple async generators in different routes
    Given I create a mock with async routes for posts and comments
    When I make concurrent requests to "/async-posts" and "/async-comments"
    Then both responses should be returned successfully
    And the posts response should contain "First Post"
    And the comments response should contain "Great post!"

  Scenario: Async plugin processing
    Given I create a mock with an async processing plugin at "GET /processed"
    When I request "GET /processed"
    Then the async response should have property "data"
    And the async response should have property "processedAsync" with value true
    And the async response should have property "timestamp"

  Scenario: Mixed sync and async plugin pipeline
    Given I create a mock with sync and async plugins at "GET /mixed"
    When I request "GET /mixed"
    Then the response should have property "base" with value "data"
    And the response should have property "syncStep" with value true
    And the response should have property "asyncStep" with boolean value true

  Scenario: Async generator with Promise rejection
    Given I create a mock with an async generator that throws at "GET /async-fail"
    When I request "GET /async-fail"
    Then I should receive status 500
    And the response should contain error "Async operation failed"

  Scenario: Async plugin error recovery
    Given I create a mock with an async error-recovery plugin at "GET /async-recovery"
    When I request "GET /async-recovery"
    Then I should receive status 200
    And the response should have property "recovered" with value true
    And the response should have property "originalError"

  Scenario: Async generator with delay configuration
    Given I create a mock with delay 20ms and async generator at "GET /delayed-async"
    When I request "GET /delayed-async" and measure time
    Then the response time should be at least 30ms
    And I should receive:
      """
      { "delayed": true, "async": true }
      """

  Scenario: Async generator with state management
    Given I create a mock with async stateful counter at "GET /async-counter"
    When I request "GET /async-counter" twice
    Then the first response should have count 1
    And the second response should have count 2
    And both responses should have processedAsync true

  Scenario: Promise-based plugin response generation
    Given I create a mock with a Promise-generating plugin at "GET /promise-gen"
    When I request "GET /promise-gen"
    Then I should receive:
      """
      { "generated": "by promise" }
      """

  Scenario: Concurrent async requests isolation
    Given I create a mock with async delay per id at "GET /isolated/:id"
    When I make concurrent requests to "/isolated/1", "/isolated/2", and "/isolated/3"
    Then all responses should have different processedAt timestamps
    And each response should have the correct id value
    And the responses should complete in expected order

  Scenario: Async plugin pipeline with context state
    Given I create a mock with two async stateful plugins at "GET /async-pipeline"
    When I request "GET /async-pipeline"
    Then the response should have property "base" with value "data"
    And the async pipeline response should have both step properties completed
