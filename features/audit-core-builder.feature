Feature: Core Builder Correctness
  As a developer using Schmock
  I want the builder to manage route configs and history safely
  So that routes are isolated and state is never leaked

  Scenario: defineRoute does not mutate the caller's config object
    Given a shared config object with no contentType
    When I register two routes with the same config object
    Then the shared config object remains unchanged after registration

  Scenario: Mutating a returned config does not affect the registered route
    Given a single config object with no contentType
    When I register one route with that config object
    And I mutate the config object after registration
    Then the registered route still responds with application/json content type

  Scenario: Trailing-slash path is treated as duplicate
    Given a fresh mock instance
    And I register GET /users without trailing slash
    And I register GET /users with trailing slash
    Then only one route exists for GET /users

  Scenario: reset() does not mutate the caller's state object
    Given a mock with external state containing key "a" equal to 1
    When I call mock reset
    Then the external state still has key "a" equal to 1
    And the mock internal state is empty

  Scenario: resetState() does not mutate the caller's state object
    Given a mock with external state containing key "b" equal to 2
    When I call mock resetState
    Then the external state still has key "b" equal to 2
    And the mock internal state is empty after resetState

  Scenario: history() returns deep clones of request records
    Given a fresh mock with a route returning a nested body
    When I handle that route once
    And I mutate the response body of the first history record
    Then history returns the original body unchanged
    And lastRequest returns the original body unchanged
