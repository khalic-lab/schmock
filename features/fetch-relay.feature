Feature: Fetch relay
  As an adapter author building a service-worker transport
  I want to route requests through Schmock's fetch interception leases from outside fetch
  So that a service worker can deliver mocked responses through the browser's network stack

  Scenario: A held relay forwards the page's fetches to the network unchanged
    Given a mock with route "GET /api/users" returning users that intercepts fetch over a recording network
    And a fetch relay is held
    When the app fetches "http://localhost/api/users" with header "x-trace" set to "abc"
    Then the recording network received the fetch with its original arguments
    And the mock emitted no lifecycle events

  Scenario: A relayed request is answered by the interception leases
    Given a mock with route "GET /api/users" returning users that intercepts fetch over a recording network
    And a fetch relay is held
    When the relay routes "GET http://localhost/api/users"
    Then the relay answered status 200 with the mocked users
    And the mock emitted "request:start,request:match,request:end"
    And the recording network received nothing

  Scenario: A relayed request no lease answers is left to the network
    Given a mock with route "GET /api/users" returning users that intercepts fetch over a recording network
    And a fetch relay is held
    When the relay routes "GET http://localhost/api/other"
    Then the relay answered nothing
    And the recording network received nothing

  Scenario: A relayed request is left to the network when no lease is held
    Given no fetch interception lease is held
    When the relay routes "GET http://localhost/api/users"
    Then the relay answered nothing

  Scenario: Releasing the relay hands fetch back to the page
    Given a mock with route "GET /api/users" returning users that intercepts fetch over a recording network
    And a fetch relay is held
    When the relay is released
    And the app fetches "http://localhost/api/users"
    Then the fetch caller received status 200 with the mocked users
    And the recording network received nothing

  Scenario: Leases taken while a relay is held are routed by it
    Given a fetch relay is held
    And a mock with route "GET /api/users" returning users that intercepts fetch over a recording network
    When the app fetches "http://localhost/api/users"
    And the relay routes "GET http://localhost/api/users"
    Then the recording network received the fetch with its original arguments
    And the relay answered status 200 with the mocked users

  Scenario: Lease options apply to relayed requests
    Given a mock with route "GET /api/users" returning users that intercepts fetch with baseUrl "/api" and a beforeResponse hook that sets header "x-hooked" to "yes"
    When the relay routes "GET http://localhost/api/users"
    Then the relay answered status 200 with header "x-hooked" set to "yes"

  Scenario: A relayed request matches an origin-form baseUrl naming its own origin
    Given a mock with route "GET /api/users" returning users that intercepts fetch with baseUrl "http://localhost/api"
    When the relay routes "GET http://localhost/api/users"
    Then the relay answered status 200 with the mocked users

  Scenario: Two leases of one mock are consulted once for a relayed request
    Given a mock with route "GET /api/users" returning users that intercepts fetch twice over a recording network
    When the relay routes "GET http://localhost/api/missing"
    Then the relay answered nothing
    And the mock emitted "request:start,request:notfound,request:end"

  Scenario: A relayed JSON body reaches the route
    Given a mock with route "POST /api/echo" echoing the body that intercepts fetch over a recording network
    When the relay routes "POST http://localhost/api/echo" with the JSON body:
      """
      { "name": "Ada" }
      """
    Then the relay answered status 200 with the JSON:
      """
      { "name": "Ada" }
      """

  Scenario: Aborting a relayed request cancels it in the mock
    Given a mock with route "GET /api/slow" that waits until released and intercepts fetch over a recording network
    And the mock records its request:end statuses
    When the relay routes "GET http://localhost/api/slow" and the request is aborted while the route runs
    Then routing rejected with an AbortError
    And the mock ended the request with status 499

  Scenario: A relayed request rejects as the fetch would
    Given a mock with route "GET /api/users" returning users that intercepts fetch with a beforeResponse hook that throws "hook failed"
    When the relay routes "GET http://localhost/api/users"
    Then routing rejected with the message "hook failed"

  Scenario: A relayed exchange is observed like an intercepted one
    Given a mock with route "GET /api/users" returning users and an exchange observer that intercepts fetch over a recording network
    When the relay routes "GET http://localhost/api/users"
    Then the number of observed exchanges is 1
    And the observed exchange was answered with status 200

  Scenario: Fetch stays forwarded until every relay hold is released
    Given a mock with route "GET /api/users" returning users that intercepts fetch over a recording network
    And two fetch relays are held
    Then both relay holds are active
    When the first relay hold is released twice
    Then the first relay hold is inactive and the second is still active
    When the app fetches "http://localhost/api/users" while the second hold is in force
    Then the recording network received the fetch with its original arguments
    And the mock emitted no lifecycle events
    When the second relay hold is released
    Then no relay hold is active
    When the app fetches "http://localhost/api/users" again
    Then the fetch caller received status 200 with the mocked users
    And the recording network received only the earlier fetch

  Scenario: A relayed request is answered by the newest lease first
    Given a mock with route "GET /api/users" returning users that intercepts fetch over a recording network
    And a newer mock with route "GET /api/users" returning "newer" that intercepts fetch
    When the relay routes "GET http://localhost/api/users"
    Then the relay answered status 200 with "newer"
    And the older mock emitted no lifecycle events

  Scenario: A relayed miss is answered with a 404 when passthrough is off
    Given a mock with route "GET /api/users" returning users that intercepts fetch with passthrough off
    When the relay routes "GET http://localhost/api/other"
    Then the relay answered status 404 with code "ROUTE_NOT_FOUND"
    And the recording network received nothing

  Scenario: A relayed request rejects with the reason its signal was aborted with
    Given a mock with route "GET /api/slow" that waits until released and intercepts fetch over a recording network
    When the relay routes "GET http://localhost/api/slow" and the request is aborted with a custom reason while the route runs
    Then routing rejected with that same abort reason

  Scenario: A relayed request outside the lease's baseUrl is left unanswered
    Given a mock with routes "GET /api/users" and "GET /admin/users" that intercepts fetch with baseUrl "/api"
    When the relay routes "GET http://localhost/admin/users"
    Then the relay answered nothing
    And the mock emitted no lifecycle events
    When the relay routes "GET http://localhost/api/users"
    Then the relay answered status 200 with the mocked users

  Scenario: A fetch dispatcher captured by a third-party wrapper obeys a relay hold
    Given a mock with route "GET /api/users" returning users that intercepts fetch over a recording network
    And a third-party wrapper captured the fetch dispatcher and replaced fetch
    And a newer mock with route "GET /api/users" returning "newer" that intercepts fetch on top of the wrapper
    And a fetch relay is held
    When the app fetches "http://localhost/api/users"
    Then the recording network received the fetch with its original arguments
    And the wrapper forwarded the fetch once
    And the older mock emitted no lifecycle events
    And the newer mock emitted no lifecycle events
