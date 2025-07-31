Feature: Debug Mode
  As a developer using Schmock
  I want comprehensive debug logging when debug mode is enabled
  So that I can troubleshoot issues and understand request processing

  Scenario: Debug mode can be enabled via configuration
    Given I have captured console output
    When I create a mock with debug configuration enabled
    Then debug mode should be activated
    And I should see configuration debug logs

  Scenario: Plugin registration is logged in debug mode
    Given I have captured console output
    And I have a test plugin "test-plugin@1.0.0"
    When I register the plugin
    Then I should see plugin registration debug logs
    And the logs should include plugin name and version
    And the logs should include available hooks

  Scenario: Request processing is logged with unique request IDs
    Given I have captured console output
    And I have a route "GET /api/test" that returns data
    When I make a request to "GET /api/test"
    Then I should see request debug logs with a unique request ID
    And the logs should include method and path
    And the logs should include request headers and query parameters

  Scenario: Route matching is logged in debug mode
    Given I have captured console output
    And I have a route "GET /api/users/:id" that returns user data
    When I make a request to "GET /api/users/123"
    Then I should see route matching debug logs
    And the logs should show the matched route pattern

  Scenario: Plugin lifecycle hooks are logged in detail
    Given I have captured console output
    And I have plugins with various lifecycle hooks
    When I make a request that triggers all hooks
    Then I should see logs for each hook execution
    And the logs should show hook names and plugin names
    And the logs should show data transformations

  Scenario: Response generation is logged with timing
    Given I have captured console output
    And I have a route that generates a response
    When I make a request to that route
    Then I should see response debug logs
    And the logs should include response status and headers
    And I should see timing information for the request

  Scenario: Error handling is logged comprehensively
    Given I have captured console output
    And I have a route that throws an error
    When I make a request to that route
    Then I should see error debug logs
    And the logs should include the error message
    And I should see onError hook execution if available

  Scenario: 404 responses are logged appropriately
    Given I have captured console output
    When I make a request to a non-existent route "/api/missing"
    Then I should see debug logs indicating no route was found
    And I should see the 404 response being generated

  Scenario: Debug mode has minimal overhead when disabled
    Given I have captured console output
    And I have a mock instance with debug mode disabled
    When I make multiple requests
    Then no debug logs should be generated
    And performance should not be significantly impacted

  Scenario: Debug logs are categorized for filtering
    Given I have captured console output
    And I have a complex mock setup with plugins
    When I make various types of requests
    Then debug logs should be categorized with prefixes
    And I should see categories like CONFIG, PLUGIN, REQUEST, HOOKS, RESPONSE, ERROR

  Scenario: Plugin ordering execution is visible in debug logs
    Given I have captured console output
    And I have plugins with enforce "pre", normal, and "post" ordering
    When I make a request
    Then debug logs should show plugins executing in the correct order
    And pre plugins should execute first
    And post plugins should execute last

  Scenario: Multiple hook types are logged for the same plugin
    Given I have captured console output
    And I have a plugin with multiple hooks (beforeRequest, afterGenerate, beforeResponse)
    When I make a request
    Then I should see separate log entries for each hook
    And each log should indicate which hook is executing

  Scenario: Plugin errors are logged with context
    Given I have captured console output
    And I have a plugin that throws an error in its beforeRequest hook
    When I make a request
    Then I should see error logs with plugin name
    And the logs should include the specific hook that failed
    And I should see error handling logs

  Scenario: State modifications are visible through debug logs
    Given I have captured console output
    And I have plugins that modify request context
    When I make a request
    Then debug logs should indicate when context is modified
    And I should see which plugins made modifications

  Scenario: Early response handling is logged
    Given I have captured console output
    And I have a plugin that returns an early response from beforeGenerate
    When I make a request
    Then debug logs should show the early response
    And subsequent generation steps should be skipped
    And this should be clearly indicated in the logs