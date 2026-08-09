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

  Scenario: Request guard prevents route side effects
    Given I create a mock whose guarded generator records each execution
    When I request the guarded route without authorization
    Then the guarded response status should be 401
    And the guarded generator should not have executed

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
    Then the response should have a "users" array with 2 items
    And the response should have "count" equal to 2
    And the response should have a "generated_at" timestamp

  Scenario: Failed installation does not activate a plugin
    Given a route and a plugin whose install hook registers a route and throws
    When I try to pipe the failing plugin
    Then pipe should report the installation failure
    And the failed installation route should not be registered
    When I request the installation test route
    Then the failed plugin should not process the response

  Scenario: Async installation is rejected before plugin registration
    Given a plugin whose install hook registers routes around a promise
    When I try to pipe the async-install plugin
    Then pipe should fail with code "PLUGIN_ASYNC_INSTALL_UNSUPPORTED"
    And the async-install plugin should remain inactive
    And the async-install routes should not be registered

  Scenario: Plugins registered during a request start on the next request
    Given a plugin that registers a late processor during beforeRequest
    When I request the late-plugin route for the first time
    Then the late processor should not have executed
    When I request the late-plugin route for the second time
    Then the late processor should have executed once

  Scenario: Reset uninstalls plugins in reverse registration order
    Given two installed plugins that record their uninstall order
    When I reset the mock with installed plugins
    Then the plugin uninstall order should be "second,first"

  Scenario: An admitted request keeps its plugin snapshot across reset
    Given an old plugin pauses an admitted request before processing
    When I reset the mock and install a new plugin before releasing the request
    Then the admitted request should use only the old plugin generation
    And the old plugin should uninstall before a new request uses the new plugin generation
