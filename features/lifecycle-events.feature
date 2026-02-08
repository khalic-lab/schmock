Feature: Lifecycle Events
  As a developer
  I want to listen for request lifecycle events
  So that I can observe and react to mock activity

  Scenario: Events fire at correct times
    Given a mock with a route "GET /items"
    And I register listeners for all events
    When I request "GET /items"
    Then the "request:start" event fired
    And the "request:match" event fired with routePath "/items"
    And the "request:end" event fired with status 200

  Scenario: Not found event fires for unmatched routes
    Given a mock with a route "GET /items"
    And I register listeners for all events
    When I request "GET /missing"
    Then the "request:start" event fired
    And the "request:notfound" event fired
    And the "request:end" event fired with status 404

  Scenario: Off removes listener
    Given a mock with a route "GET /items"
    And I register and remove a listener
    When I request "GET /items"
    Then the removed listener did not fire

  Scenario: Reset clears all listeners
    Given a mock with a route "GET /items"
    And I register listeners for all events
    When I reset the mock
    And I add a route "GET /items" again
    And I request "GET /items" after reset
    Then no events were collected after reset
