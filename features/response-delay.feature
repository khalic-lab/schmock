Feature: Response Delay
  As a developer
  I want to configure response delays per-route
  So that I can simulate realistic API latency

  Scenario: Route delay overrides global delay
    Given a mock with global delay of 200ms
    And a route "GET /fast" with delay of 10ms
    And a route "GET /default" with no delay override
    When I request "GET /fast"
    Then the response took less than 100ms
    When I request "GET /default" with timing
    Then that response took at least 150ms

  Scenario: Route delay supports random range
    Given a mock with no global delay
    And a route "GET /random" with delay range 10 to 30
    When I request "GET /random"
    Then the response took at least 10ms

  Scenario: No route delay inherits global delay
    Given a mock with global delay of 50ms
    And a route "GET /items" with no delay override
    When I request "GET /items" with timing
    Then that response took at least 40ms
