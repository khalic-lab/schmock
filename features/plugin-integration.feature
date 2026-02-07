Feature: Plugin Pipeline Integration
  As a developer building complex applications
  I want to use plugins with the new pipeline architecture
  So that I can create extensible mock behaviors with clear data flow

  Scenario: Plugin state sharing with pipeline
    Given I create a mock with a counter plugin using route state
    When I request "GET /counter" three times
    Then each response should have incrementing "request_number" values
    And each response should have a "processed_at" timestamp
    And the route state should persist across requests

  Scenario: Multiple plugins in pipeline
    Given I create a mock with auth and wrapper plugins
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
    Given I create a mock with an auth guard plugin
    When I request "GET /protected" without authorization
    Then the status should be 401
    And I should receive:
      """
      { "error": "Unauthorized", "code": "AUTH_REQUIRED" }
      """

  Scenario: Pipeline order and response transformation
    Given I create a mock with three ordered step plugins
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
    Given I create a mock with a metadata wrapper plugin
    When I request "GET /users"
    Then the response should have a "users" array
    And the response should have a "count" field
    And the response should have a "generated_at" timestamp
