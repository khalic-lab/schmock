Feature: Lifecycle Events
  As a developer
  I want to listen for request lifecycle events
  So that I can observe and react to mock activity

  Scenario: Events fire at correct times
    Given a mock with a route "GET /items"
    And I register listeners for all events
    When I request "GET /items"
    Then the event order should be "request:start,request:match,request:end"
    And the "request:match" event fired with routePath "/items"
    And the "request:end" event fired with status 200

  Scenario: Not found event fires for unmatched routes
    Given a mock with a route "GET /items"
    And I register listeners for all events
    When I request "GET /missing"
    Then the event order should be "request:start,request:notfound,request:end"
    And the "request:end" event fired with status 404

  Scenario: Out-of-namespace requests still report a route miss
    Given a namespaced mock with a route "GET /users"
    And I register listeners for all events
    When I request "GET /other/users"
    Then the event order should be "request:start,request:notfound,request:end"
    And every event carried the path "/other/users"

  Scenario: Namespaced events carry the original request path
    Given a namespaced mock with a route "GET /users"
    And I register listeners for all events
    When I request "GET /api/users"
    Then the event order should be "request:start,request:match,request:end"
    And every event carried the path "/api/users"
    And the "request:match" event fired with routePath "/users"

  Scenario: A failing request ends with the original path
    Given a namespaced mock with a throwing route "GET /boom"
    And I register listeners for all events
    When I request "GET /api/boom"
    Then the event order should be "request:start,request:match,request:end"
    And every event carried the path "/api/boom"
    And the "request:end" event fired with status 500

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

  Scenario: Throwing listeners do not alter request handling
    Given a successful route with throwing and healthy lifecycle listeners
    When I request the listener isolation route
    Then the listener isolation response status should be 200
    And the healthy listeners should still fire in order
    And request end should fire exactly once

  Scenario: Lifecycle payloads are observational snapshots
    Given a parameterized route that reports its headers and parameters
    And lifecycle listeners attempt to change headers and parameters
    When I request the observational route with original values
    Then the generator should receive the original header and parameter

  Scenario: Listener changes take effect on the next event
    Given a listener that registers another start listener
    When I request the listener snapshot route twice
    Then the added listener should skip the first request and run on the second
