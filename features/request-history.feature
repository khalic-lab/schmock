Feature: Request History & Spy API
  As a test author
  I want to inspect what requests were made to my mock
  So that I can verify my code called the right endpoints

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

  Scenario: 404 requests are not recorded in history
    Given I create a mock with only a users route
    When I request "GET /nonexistent"
    Then the mock should not have been called
    And the call count should be 0

  Scenario: maxHistorySize bounds the history with FIFO eviction
    Given I create a mock with maxHistorySize 3 and a users route
    When I issue 5 sequenced requests to "GET /users"
    Then the call count should be 3
    And the retained request sequence should be "3,4,5"

  Scenario: Resetting history preserves routes and shared state
    Given I create a stateful mock and record a request
    When I reset only the request history
    Then the call count should be 0
    And the registered route should still respond
    And the shared state marker should still be "preserved"

  Scenario: Full reset prevents stale requests from entering new history
    Given an admitted request is paused before completion
    When I reset and complete a request in the new generation
    And I release the admitted request
    Then the admitted caller should receive its original response
    And history should contain only the new generation request

  Scenario: Resetting history is a barrier for pending commits
    Given an admitted request is paused before completion
    When I reset history before releasing the request
    And I release the admitted request
    Then request history should remain empty

  Scenario: History snapshots request and response sources when recorded
    Given a route and mutable nested request options
    When I handle the mutable request and then mutate its sources
    Then history should retain the original nested request and response values

  Scenario: Shared memory is copied into isolated history snapshots
    Given a route and a nested shared-memory request body
    When I handle the shared-memory request and mutate its source and first history result
    Then a later history result should contain the original bytes in ordinary memory
