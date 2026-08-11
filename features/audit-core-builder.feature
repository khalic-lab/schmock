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

  Scenario: A matched route whose generator throws is recorded in history
    Given a mock with a healthy route and a route whose generator throws
    When I request the healthy route and then the throwing route
    Then the throwing request should be recorded in history with status 500
    And the call count for the throwing route should be 1

  Scenario: A failing route honours its own delay override
    Given a mock with a global delay and a slower failing route override
    When I request the failing route
    Then the failing response should be 500 after the route delay

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

  Scenario: Default shared state persists across requests
    Given a mock with no configured state and an incrementing route
    When I request the default-state route twice
    Then the counter responses should be 1 and 2
    And the mock shared counter state should be 2

  Scenario: Resetting state does not replace state on the caller config
    Given a caller config containing external state
    When I create a mock from the config and reset its state
    Then the caller config should still reference the external state
    And the mock internal state is empty after resetState
