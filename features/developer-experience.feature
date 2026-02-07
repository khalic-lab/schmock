Feature: Developer Experience
  As a developer new to Schmock
  I want clear error messages and intuitive behavior
  So that I can quickly understand and fix common mistakes

  Scenario: Forgetting to provide response data
    Given I create a mock with no response data on "GET /empty"
    When I request "GET /empty"
    Then I should receive status 204
    And the response body should be empty

  Scenario: Using wrong parameter name in route
    Given I create a mock with a mismatched parameter name on "GET /users/:userId"
    When I request "GET /users/123"
    Then the wrong parameter should be undefined

  Scenario: Correct parameter usage
    Given I create a mock with a matching parameter name on "GET /users/:userId"
    When I request "GET /users/123"
    Then I should receive:
      """
      { "id": "123" }
      """

  Scenario: Mixing content types without explicit configuration
    Given I create a mock with JSON, text, number, and boolean routes
    When I test all mixed content type routes
    Then JSON route should have content-type "application/json"
    And text route should have content-type "text/plain"
    And number route should have content-type "text/plain"
    And boolean route should have content-type "text/plain"

  Scenario: Expecting JSON but getting string conversion
    Given I create a mock returning a decimal number on "GET /price"
    When I request "GET /price"
    Then I should receive text "19.99"
    And the content-type should be "text/plain"

  Scenario: Forgetting await with async generators
    Given I create a mock with an async handler on "GET /data"
    When I request "GET /data"
    Then I should receive:
      """
      { "async": true }
      """
    And the content-type should be "application/json"

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

  Scenario: Query parameter edge cases
    Given I create a mock that echoes query parameters on "GET /search"
    When I request "GET /search?q=test&page=&empty"
    Then I should receive:
      """
      { "term": "test", "page": "", "empty": "" }
      """

  Scenario: Headers case sensitivity
    Given I create a mock that echoes headers on "GET /auth"
    When I request "GET /auth" with headers:
      """
      { "Authorization": "Bearer token", "Content-Type": "application/json" }
      """
    Then the header case sensitivity should show expected values

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

  Scenario: Namespace confusion with absolute paths
    Given I create a mock with namespace "/api/v1" and a users route
    When I test both namespace scenarios
    Then the wrong namespace should receive status 404
    And the correct namespace should receive:
      """
      []
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

  Scenario: Common typos in method names
    Given I create an empty mock for testing method typos
    When I test all common method typos
    Then the wrong method typo should throw RouteParseError
    And the lowercase method typo should throw RouteParseError
    And the missing space typo should throw RouteParseError

  Scenario: Registering duplicate routes first route wins
    Given I create a mock with two routes on "GET /items" with different data
    When I request "GET /items"
    Then the first route response should win:
      """
      [{ "id": 1 }]
      """

  Scenario: Plugin returning unexpected structure
    Given I create a mock with a plugin that returns an invalid structure
    When I request "GET /bad"
    Then I should receive status 500
    And the response should contain error "didn't return valid result"
