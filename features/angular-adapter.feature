Feature: Angular Adapter
  As an Angular developer
  I want to use Schmock with Angular's HttpClient
  So that I can mock API responses in my Angular applications

  # Error Status Handling
  # The adapter should automatically convert error status codes to HttpErrorResponse

  Scenario Outline: Auto-convert error status to HttpErrorResponse
    Given I create an Angular error mock for "<route>" with status "<status>"
    When I make an Angular request to "<route>"
    Then the response should be an HttpErrorResponse
    And the error status should be "<status>"

    Examples:
      | route              | status |
      | GET /api/not-found | 404    |
      | GET /api/invalid   | 400    |
      | GET /api/error     | 500    |

  Scenario: Success status returns HttpResponse
    Given I create an Angular mock with:
      """
      mock('GET /api/users', [200, { users: [] }])
      """
    When I make an Angular request to "GET /api/users"
    Then the response should be an HttpResponse
    And the status should be 200

  Scenario: 201 Created returns HttpResponse
    Given I create an Angular mock with:
      """
      mock('POST /api/users', [201, { id: 1, name: 'John' }])
      """
    When I make an Angular request to "POST /api/users"
    Then the response should be an HttpResponse
    And the status should be 201

  # Adapter Configuration Options

  Scenario: Requests outside baseUrl are passed through
    Given I create an Angular mock with baseUrl "/api":
      """
      mock('GET /api/users', [200, { users: [] }])
      """
    When I make an Angular request to "GET /external/data"
    Then the request should pass through to the real backend

  Scenario: Use passthrough option to handle unmatched routes
    Given I create an Angular mock with passthrough enabled:
      """
      mock('GET /api/users', [200, { users: [] }])
      """
    When I make an Angular request to "GET /api/unknown"
    Then the request should pass through to the real backend

  Scenario: Disable passthrough for strict mocking
    Given I create an Angular mock with passthrough disabled:
      """
      mock('GET /api/users', [200, { users: [] }])
      """
    When I make an Angular request to "GET /api/unknown"
    Then the response should be an HttpErrorResponse
    And the error status should be 404
    And the error body should contain "No matching mock route found"

  Scenario: Use transformRequest to modify request before mocking
    Given I create an Angular mock with transformRequest:
      """
      mock('GET /api/users', ({ headers }) => [200, { auth: headers.authorization }])
      """
    When I make an Angular request to "GET /api/users" with custom headers
    Then the response should be an HttpResponse
    And the response body should contain the transformed authorization header

  Scenario: Use transformResponse to modify response before returning
    Given I create an Angular mock with transformResponse:
      """
      mock('GET /api/users', [200, { users: [] }])
      """
    When I make an Angular request to "GET /api/users"
    Then the response should be an HttpResponse
    And the response body should contain the transformed data

  Scenario: Use custom errorFormatter for error responses
    Given I create an Angular mock with custom errorFormatter:
      """
      mock('GET /api/error', () => { throw new Error('Custom error') })
      """
    When I make an Angular request to "GET /api/error"
    Then the response should be an HttpErrorResponse
    And the error status should be 500
    And the error body should use the custom error format

  # OpenAPI Spec with Angular Adapter Options

  Scenario: Auto-created interceptor respects baseUrl option
    Given I create an Angular interceptor from spec with baseUrl "/api"
    When I make an Angular request to "GET /external/data"
    Then the request should pass through to the real backend
