Feature: Error Handling
  As a developer using Schmock
  I want comprehensive error handling and clear error messages
  So that I can quickly diagnose and fix issues in my mocks

  Scenario: Route not found returns 404
    Given I create a mock with a GET /users route returning a user list
    When I request "GET /posts"
    Then I should receive status 404
    And the response should contain error "Route not found: GET /posts"
    And the response should have error code "ROUTE_NOT_FOUND"

  Scenario: Wrong HTTP method returns 404
    Given I create a mock with a GET /api/data route returning success
    When I request "POST /api/data"
    Then I should receive status 404
    And the response should contain error "Route not found: POST /api/data"

  Scenario: Invalid route key throws RouteDefinitionError
    Given I attempt to register a route with an invalid HTTP method
    Then it should throw a RouteDefinitionError
    And the error message should contain "Invalid HTTP method"

  Scenario: Empty route path throws RouteDefinitionError
    Given I attempt to register a route with an empty path
    Then it should throw a RouteDefinitionError
    And the error message should contain "Invalid route format"

  Scenario: Plugin throws error returns 500 with PluginError
    Given I create a mock with a plugin that throws "Plugin failed"
    When I request "GET /test"
    Then I should receive status 500
    And the response should contain error 'Plugin "failing-plugin" failed: Plugin failed'
    And the response should have error code "PLUGIN_ERROR"

  Scenario: Plugin onError hook recovers from failure
    Given I create a mock with a recoverable plugin that returns "recovered"
    When I request "GET /test"
    Then I should receive status 200
    And I should receive text "recovered"

  Scenario: Plugin returns invalid result structure
    Given I create a mock with a plugin returning an invalid result
    When I request "GET /test"
    Then I should receive status 500
    And the response should contain error "didn't return valid result"

  Scenario: Function generator throws error returns 500
    Given I create a mock with a generator that throws "Generator failed"
    When I request "GET /fail"
    Then I should receive status 500
    And the response should contain error "Generator failed"
    And the response should have error code "INTERNAL_ERROR"

  Scenario: Invalid JSON generator with JSON content-type throws RouteDefinitionError
    Given I attempt to register a route with a circular reference as JSON
    Then it should throw a RouteDefinitionError
    And the error message should contain "not valid JSON"

  Scenario: Namespace mismatch returns 404
    Given I create a mock with namespace "/api/v1" and a GET /users route
    When I request "GET /users"
    Then I should receive status 404
    And the response should contain error "Route not found: GET /users"

  Scenario: Multiple plugin failures cascade properly
    Given I create a mock with two failing plugins piped in sequence
    When I request "GET /cascade"
    Then I should receive status 500
    And the response should contain error 'Plugin "first-fail" failed'

  Scenario: Plugin onError hook also fails
    Given I create a mock with a plugin whose error handler also throws
    When I request "GET /broken"
    Then I should receive status 500
    And the response should contain error 'Plugin "broken-handler" failed'

  Scenario: Empty parameter in route returns 404
    Given I create a mock with a parameterized route "GET /users/:id"
    When I request "GET /users/"
    Then I should receive status 404
    And the response should contain error "Route not found: GET /users/"

  Scenario: Async generator error handling
    Given I create a mock with an async generator that throws "Async generator failed"
    When I request "GET /async-fail"
    Then I should receive status 500
    And the response should contain error "Async generator failed"

  Scenario: Error responses include proper headers
    Given I create a mock with a generator that throws "Test error"
    When I request "GET /error"
    Then I should receive status 500
    And the content-type should be "application/json"
    And the response body should be valid JSON

  Scenario: Plugin onError returns response with status 0
    Given I create a mock with a plugin whose error handler returns status 0
    When I request "GET /zero"
    Then I should receive status 0
    And I should receive text "zero status"

  Scenario: Plugin null/undefined return handling
    Given I create a mock with a plugin that returns null
    When I request "GET /null"
    Then I should receive status 500
    And the response should contain error "didn't return valid result"
