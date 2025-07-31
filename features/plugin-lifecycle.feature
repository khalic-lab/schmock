Feature: Plugin Lifecycle Hooks
  As a plugin developer
  I want to hook into various stages of request processing
  So that I can extend and customize Schmock's behavior

  Scenario: Plugin hooks are called in correct order
    Given I create a mock with a tracking plugin
    And I have a route "GET /test" that returns data
    When I request "GET /test"
    Then the plugin hooks should be called in order:
      | hook            |
      | beforeRequest   |
      | beforeGenerate  |
      | generate        |
      | afterGenerate   |
      | beforeResponse  |

  Scenario: beforeRequest hook can modify the context
    Given I create a mock with a plugin that adds custom headers
    And I have a route "GET /headers" that echoes headers
    When I request "GET /headers"
    Then the response should include the custom header

  Scenario: beforeGenerate hook can return early response
    Given I create a mock with a caching plugin
    And the cache contains data for "GET /cached"
    When I request "GET /cached"
    Then the response should be from cache
    And the generate hook should not be called

  Scenario: afterGenerate hook can transform data
    Given I create a mock with a transformation plugin
    And I have a route "GET /transform" that returns raw data
    When I request "GET /transform"
    Then the response should be transformed

  Scenario: beforeResponse hook can modify final response
    Given I create a mock with a response modifier plugin
    And I have a route "GET /modify" that returns data
    When I request "GET /modify"
    Then the response should include custom headers
    And the response should have modified status

  Scenario: onError hook can handle errors gracefully
    Given I create a mock with an error handling plugin
    And I have a route "GET /error" that throws an error
    When I request "GET /error"
    Then the status should be 503
    And the response should have custom error format

  Scenario: Plugin enforce ordering works correctly
    Given I create a mock with multiple plugins:
      | name   | enforce |
      | first  | pre     |
      | second |         |
      | third  | post    |
    When I request "GET /order"
    Then the plugins should execute in order: first, second, third

  Scenario: Multiple plugins can compose transformations
    Given I create a mock with plugins:
      | name       | transform                |
      | uppercase  | converts to uppercase    |
      | exclaim    | adds exclamation marks   |
    And I have a route "GET /compose" that returns "hello"
    When I request "GET /compose"
    Then the response should be "HELLO!!!"

  Scenario: Plugin state is shared across hooks
    Given I create a mock with a stateful plugin
    And I have a route "GET /stateful"
    When I request "GET /stateful"
    Then the plugin state should be preserved across hooks

  Scenario: Plugin errors are wrapped correctly
    Given I create a mock with a failing plugin
    And I have a route "GET /plugin-error"
    When I request "GET /plugin-error"
    Then the status should be 500
    And the error should indicate which plugin failed