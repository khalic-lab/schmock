Feature: Request History & Spy API
  As a test author
  I want to inspect what requests were made to my mock
  So that I can verify my code called the right endpoints

  Scenario: No requests recorded initially
    Given I create a mock with a single GET route for history
    Then the mock should not have been called
    And the call count should be 0
    And the history should be empty

  Scenario: Record a single GET request
    Given I create a mock returning users at "GET /users"
    When I request "GET /users"
    Then the mock should have been called
    And the call count should be 1
    And the history should have 1 entry
    And the last request method should be "GET"
    And the last request path should be "/users"

  Scenario: Record multiple requests
    Given I create a mock with GET and POST user routes
    When I request "GET /users"
    And I request "POST /users" with body:
      """
      { "name": "Jane" }
      """
    And I request "GET /users"
    Then the call count should be 3
    And the call count for "GET /users" should be 2
    And the call count for "POST /users" should be 1 request

  Scenario: Filter history by method and path
    Given I create a mock with users and posts routes
    When I request "GET /users"
    And I request "POST /users" with body:
      """
      { "name": "Jane" }
      """
    And I request "GET /posts"
    Then the history for "GET /users" should have 1 record
    And the history for "POST /users" should have 1 record
    And the history for "GET /posts" should have 1 entry
    And the history for "DELETE /users" should have 0 entries

  Scenario: Check if specific route was called
    Given I create a mock with users and posts list routes
    When I request "GET /users"
    Then "GET /users" should have been called
    And "GET /posts" should not have been called

  Scenario: Request record captures full details
    Given I create a mock with a parameterized POST route
    When I request "POST /users/42" with headers and body:
      """
      {
        "headers": { "authorization": "Bearer token123", "content-type": "application/json" },
        "body": { "name": "John", "email": "john@example.com" }
      }
      """
    Then the last request should have:
      | field   | value                |
      | method  | POST                 |
      | path    | /users/42            |
    And the last request params should include "id" = "42"
    And the last request headers should include "authorization" = "Bearer token123"
    And the last request body should have property "name" with value "John"
    And the last request should have a timestamp
    And the last request response status should be 200

  Scenario: Get last request for a specific route
    Given I create a mock echoing POST body at "/users"
    When I request "POST /users" with body:
      """
      { "name": "First" }
      """
    And I request "POST /users" with body:
      """
      { "name": "Second" }
      """
    Then the last request for "POST /users" body should have property "name" with value "Second"

  Scenario: History works with namespaced mocks
    Given I create a namespaced mock under "/api"
    When I request "GET /api/users"
    Then the mock should have been called
    And the call count should be 1
    And the last request path should be "/users"

  Scenario: 404 requests are not recorded in history
    Given I create a mock with only a users route
    When I request "GET /nonexistent"
    Then the mock should not have been called
    And the call count should be 0
