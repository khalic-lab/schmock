Feature: Fluent API Builder
  As a developer
  I want to define mocks using a fluent API
  So that I can create readable and maintainable mocks

  # Design Decision: We use 'METHOD /path' string keys for routes
  # This pattern is:
  # - Familiar from OpenAPI/Swagger documentation
  # - Used by modern frameworks like Hono
  # - Enables quick visual scanning of all routes
  # - Keeps method and path together as single source of truth
  # - Allows copy-paste from API documentation
  # - TypeScript validates format with template literal types

  Scenario: Simple route with static response
    Given I create a mock with:
      """
      schmock()
        .routes({
          'GET /users': {
            response: () => [{ id: 1, name: 'John' }]
          }
        })
      """
    When I request "GET /users"
    Then I should receive:
      """
      [{ "id": 1, "name": "John" }]
      """

  Scenario: Route with dynamic response and state
    Given I create a mock with:
      """
      schmock()
        .state({ count: 0 })
        .routes({
          'GET /counter': {
            response: ({ state }) => {
              state.count++;
              return { value: state.count };
            }
          }
        })
      """
    When I request "GET /counter" twice
    Then the first response should have value 1
    And the second response should have value 2

  Scenario: Route with parameters
    Given I create a mock with:
      """
      schmock()
        .routes({
          'GET /users/:id': {
            response: ({ params }) => ({ userId: params.id })
          }
        })
      """
    When I request "GET /users/123"
    Then I should receive:
      """
      { "userId": "123" }
      """

  Scenario: Response with custom status code
    Given I create a mock with:
      """
      schmock()
        .routes({
          'POST /users': {
            response: ({ body }) => [201, { id: 1, ...body }]
          }
        })
      """
    When I request "POST /users" with body:
      """
      { "name": "Alice" }
      """
    Then the status should be 201
    And I should receive:
      """
      { "id": 1, "name": "Alice" }
      """

  Scenario: 404 for undefined routes
    Given I create a mock with:
      """
      schmock()
        .routes({
          'GET /users': {
            response: () => []
          }
        })
      """
    When I request "GET /posts"
    Then the status should be 404

  Scenario: Query parameters
    Given I create a mock with:
      """
      schmock()
        .routes({
          'GET /search': {
            response: ({ query }) => ({ 
              results: [], 
              query: query.q 
            })
          }
        })
      """
    When I request "GET /search?q=test"
    Then I should receive:
      """
      { "results": [], "query": "test" }
      """

  Scenario: Request headers access
    Given I create a mock with:
      """
      schmock()
        .routes({
          'GET /auth': {
            response: ({ headers }) => ({ 
              authenticated: headers.authorization === 'Bearer token123' 
            })
          }
        })
      """
    When I request "GET /auth" with headers:
      """
      { "authorization": "Bearer token123" }
      """
    Then I should receive:
      """
      { "authenticated": true }
      """

  Scenario: Configuration with namespace
    Given I create a mock with:
      """
      schmock()
        .config({ namespace: '/api/v1' })
        .routes({
          'GET /users': {
            response: () => []
          }
        })
      """
    When I request "GET /api/v1/users"
    Then I should receive:
      """
      []
      """