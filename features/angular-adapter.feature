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
