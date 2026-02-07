Feature: Callable API
  As a developer
  I want to define mocks using a direct callable API
  So that I can create readable and maintainable mocks with minimal boilerplate

  # Design Decision: We use a callable factory function with route definitions
  # This pattern is:
  # - Direct and minimal boilerplate
  # - No need for build() calls
  # - Global configuration at factory level
  # - Plugin pipeline with .pipe() chaining
  # - Route-specific configuration support

  Scenario: Simple route with generator function
    Given I create a mock with a JSON generator at "GET /users"
    When I request "GET /users"
    Then I should receive:
      """
      [{ "id": 1, "name": "John" }]
      """

  Scenario: Route with dynamic response and global state
    Given I create a mock with a stateful counter
    When I request "GET /counter" twice
    Then the first response should have value 1
    And the second response should have value 2

  Scenario: Route with parameters
    Given I create a mock with a parameterized route "GET /users/:id"
    When I request "GET /users/123"
    Then I should receive:
      """
      { "userId": "123" }
      """

  Scenario: Response with custom status code
    Given I create a mock returning status 201 for "POST /users"
    When I request "POST /users" with body:
      """
      { "name": "Alice" }
      """
    Then the status should be 201
    And I should receive:
      """
      { "id": 1, "name": "Alice" }
      """

  Scenario: Static data response
    Given I create a mock with static config data at "GET /config"
    When I request "GET /config"
    Then I should receive:
      """
      { "version": "1.0.0", "features": ["auth"] }
      """

  Scenario: 404 for undefined routes
    Given I create a mock with only a "GET /users" route
    When I request "GET /posts"
    Then the status should be 404

  Scenario: Query parameters
    Given I create a mock that reads query parameters at "GET /search"
    When I request "GET /search?q=test"
    Then I should receive:
      """
      { "results": [], "query": "test" }
      """

  Scenario: Request headers access
    Given I create a mock that reads headers at "GET /auth"
    When I request "GET /auth" with headers:
      """
      { "authorization": "Bearer token123" }
      """
    Then I should receive:
      """
      { "authenticated": true }
      """

  Scenario: Global configuration with namespace
    Given I create a mock with namespace "/api/v1"
    When I request "GET /api/v1/users"
    Then I should receive:
      """
      []
      """

  Scenario: Plugin pipeline with pipe chaining
    Given I create a mock with two passthrough plugins
    When I request "GET /users"
    Then I should receive:
      """
      [{ "id": 1, "name": "John" }]
      """
