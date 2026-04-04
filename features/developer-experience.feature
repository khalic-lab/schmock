Feature: Developer Experience
  As a developer new to Schmock
  I want clear error messages and intuitive behavior
  So that I can quickly understand and fix common mistakes

  Scenario: State confusion between global and local state
    Given I create a mock with global state and a local state counter
    When I request "GET /counter" twice
    Then the first response should have:
      """
      { "global": 1, "local": 1 }
      """
    And the second response should have:
      """
      { "global": 1, "local": 2 }
      """

  Scenario: Route precedence with similar paths
    Given I create a mock with an exact route and a parameterized route on "/users"
    When I test both route precedence scenarios
    Then the profile route should return exact match:
      """
      { "type": "profile" }
      """
    And the parameterized route should match with param:
      """
      { "type": "user", "id": "123" }
      """

  Scenario: Plugin order affecting results
    Given I create a mock with two plugins that each set a step number
    When I request "GET /order"
    Then I should receive:
      """
      { "original": true, "step": 2 }
      """

  Scenario: Plugin expecting different context structure
    Given I create a mock with a plugin that reads context properties
    When I request "POST /analyze?test=1" with body:
      """
      { "data": "test" }
      """
    Then I should receive:
      """
      { "method": "POST", "path": "/analyze", "hasBody": true, "hasQuery": true }
      """

  Scenario: Response tuple format edge cases
    Given I create a mock with three tuple response routes
    When I test all tuple response formats
    Then the created endpoint should return status 201 with empty body
    And the headers endpoint should return status 200 with data and custom header
    And the empty endpoint should return status 204 with null body

  Scenario: Registering duplicate routes first route wins
    Given I create a mock with two routes on "GET /items" with different data
    When I request "GET /items"
    Then the first route response should win:
      """
      [{ "id": 1 }]
      """

