Feature: Angular Adapter
  As an Angular developer
  I want to use Schmock with Angular's HttpClient
  So that I can mock API responses in my Angular applications

  # Error Status Handling
  # The adapter should automatically convert error status codes to HttpErrorResponse

  Scenario: Auto-convert 404 status to HttpErrorResponse
    Given I create an Angular mock with:
      """
      mock('GET /api/users/999', [404, { message: 'User not found' }])
      """
    When I make an Angular request to "GET /api/users/999"
    Then the response should be an HttpErrorResponse
    And the error status should be 404
    And the error body should contain "User not found"

  Scenario: Auto-convert 400 status to HttpErrorResponse
    Given I create an Angular mock with:
      """
      mock('GET /api/invalid', [400, { error: 'Bad request' }])
      """
    When I make an Angular request to "GET /api/invalid"
    Then the response should be an HttpErrorResponse
    And the error status should be 400

  Scenario: Auto-convert 500 status to HttpErrorResponse
    Given I create an Angular mock with:
      """
      mock('GET /api/error', [500, { error: 'Internal server error' }])
      """
    When I make an Angular request to "GET /api/error"
    Then the response should be an HttpErrorResponse
    And the error status should be 500

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

  # Helper Functions

  Scenario: Use notFound helper
    Given I create an Angular mock using helpers:
      """
      mock('GET /api/users/999', notFound('User not found'))
      """
    When I make an Angular request to "GET /api/users/999"
    Then the response should be an HttpErrorResponse
    And the error status should be 404
    And the error body should contain "User not found"

  Scenario: Use badRequest helper
    Given I create an Angular mock using helpers:
      """
      mock('POST /api/users', badRequest('Invalid email format'))
      """
    When I make an Angular request to "POST /api/users"
    Then the response should be an HttpErrorResponse
    And the error status should be 400
    And the error body should contain "Invalid email format"

  Scenario: Use unauthorized helper
    Given I create an Angular mock using helpers:
      """
      mock('GET /api/protected', unauthorized('Token expired'))
      """
    When I make an Angular request to "GET /api/protected"
    Then the response should be an HttpErrorResponse
    And the error status should be 401

  Scenario: Use forbidden helper
    Given I create an Angular mock using helpers:
      """
      mock('GET /api/admin', forbidden('Admin access required'))
      """
    When I make an Angular request to "GET /api/admin"
    Then the response should be an HttpErrorResponse
    And the error status should be 403

  Scenario: Use serverError helper
    Given I create an Angular mock using helpers:
      """
      mock('GET /api/broken', serverError('Database connection failed'))
      """
    When I make an Angular request to "GET /api/broken"
    Then the response should be an HttpErrorResponse
    And the error status should be 500

  Scenario: Use created helper
    Given I create an Angular mock using helpers:
      """
      mock('POST /api/users', created({ id: 1, name: 'John' }))
      """
    When I make an Angular request to "POST /api/users"
    Then the response should be an HttpResponse
    And the status should be 201

  Scenario: Use noContent helper
    Given I create an Angular mock using helpers:
      """
      mock('DELETE /api/users/1', noContent())
      """
    When I make an Angular request to "DELETE /api/users/1"
    Then the response should be an HttpResponse
    And the status should be 204

  Scenario: Use paginate helper
    Given I create an Angular mock with pagination:
      """
      const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
      mock('GET /api/items', ({ query }) => paginate(items, {
        page: parseInt(query.page || '1'),
        pageSize: parseInt(query.pageSize || '2')
      }))
      """
    When I make an Angular request to "GET /api/items?page=1&pageSize=2"
    Then the response should be an HttpResponse
    And the response body should have 2 items in data
    And the response should have total 5
    And the response should have totalPages 3

  # Adapter Configuration Options

  Scenario: Use baseUrl to filter intercepted requests
    Given I create an Angular mock with baseUrl "/api":
      """
      mock('GET /api/users', [200, { users: [] }])
      """
    When I make an Angular request to "GET /api/users"
    Then the response should be an HttpResponse
    And the status should be 200

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

  # URL and Query Parameter Handling

  Scenario: Handle full URLs with protocol and host
    Given I create an Angular mock with:
      """
      mock('GET /api/users', [200, { users: [] }])
      """
    When I make an Angular request to "GET http://localhost:4200/api/users"
    Then the response should be an HttpResponse
    And the status should be 200

  Scenario: Extract query parameters from URL
    Given I create an Angular mock with query handling:
      """
      mock('GET /api/search', ({ query }) => [200, { q: query.q, page: query.page }])
      """
    When I make an Angular request to "GET /api/search?q=typescript&page=2"
    Then the response should be an HttpResponse
    And the response body should contain both query parameters
