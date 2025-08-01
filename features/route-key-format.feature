Feature: Route Key Format
  As a developer
  I want to use 'METHOD /path' format for route keys
  So that I have a consistent and readable API

  # DX Design Choice:
  # We chose 'METHOD /path' string format over alternatives like:
  # - Nested objects: { '/users': { GET: {...} } } - too much nesting
  # - Method chaining: .get('/users', ...) - less declarative
  # - Array format: [{ method: 'GET', path: '/users' }] - too verbose
  #
  # Benefits of 'METHOD /path':
  # - Matches OpenAPI/Swagger format
  # - Single line per route for easy scanning
  # - Natural reading: "GET /users returns..."
  # - TypeScript can validate with template literal types

  Scenario Outline: Valid route key formats
    When I parse route key "<key>"
    Then the method should be "<method>"
    And the path should be "<path>"
    
    Examples:
      | key                        | method | path                       |
      | GET /users                 | GET    | /users                     |
      | POST /api/users            | POST   | /api/users                 |
      | DELETE /users/:id          | DELETE | /users/:id                 |
      | PUT /posts/:id/publish     | PUT    | /posts/:id/publish         |
      | PATCH /settings            | PATCH  | /settings                  |
      | HEAD /health               | HEAD   | /health                    |
      | OPTIONS /users             | OPTIONS| /users                     |

  Scenario Outline: Invalid route key formats
    When I parse route key "<key>"
    Then an error should be thrown with message matching "<error>"
    
    Examples:
      | key           | error                                    |
      | /users        | Invalid route key format                 |
      | GET           | Invalid route key format                 |
      | INVALID /path | Invalid route key format                 |
      | get /users    | Invalid route key format                 |
      | GET/users     | Invalid route key format                 |

  Scenario: Extract parameters from path
    When I parse route key "GET /users/:userId/posts/:postId"
    Then the method should be "GET"
    And the path should be "/users/:userId/posts/:postId"
    And the parameters should be:
      """
      ["userId", "postId"]
      """

  Scenario: No parameters in simple path
    When I parse route key "GET /users"
    Then the parameters should be:
      """
      []
      """

  Scenario: Path with query string placeholder
    When I parse route key "GET /search"
    Then the method should be "GET"
    And the path should be "/search"
    And query parameters are handled separately at runtime

  Scenario: Complex nested paths
    When I parse route key "DELETE /api/v2/organizations/:orgId/teams/:teamId/members/:userId"
    Then the method should be "DELETE"
    And the path should be "/api/v2/organizations/:orgId/teams/:teamId/members/:userId"
    And the parameters should be:
      """
      ["orgId", "teamId", "userId"]
      """