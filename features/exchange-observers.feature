Feature: Exchange observers
  As a plugin author
  I want to observe each request a mock answered through fetch interception, as its caller received it
  So that reporting tools can be built as ordinary Schmock plugins

  Scenario: An observer sees the request and the response the fetch caller received
    Given a mock with route "GET /api/users" returning users and an exchange observer
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/users?page=2#top" with header "x-trace" set to "abc"
    Then the number of observed exchanges is 1
    And the observed exchange was answered with status 200
    And the observed request is "GET http://localhost/api/users?page=2"
    And the observed request header "x-trace" is "abc"
    And the observed response header "content-type" is "application/json"
    And the observed response body is the mocked users
    And the observed exchange ended no earlier than it started

  Scenario: The observed response is the one beforeResponse produced
    Given a mock with route "GET /api/users" returning users and an exchange observer
    And the mock intercepts fetch with a beforeResponse hook that answers 202 with header "x-hooked" set to "yes"
    When the app fetches "http://localhost/api/users"
    Then the observed exchange was answered with status 202
    And the observed response header "x-hooked" is "yes"
    And the fetch caller received status 202

  Scenario: The observed response is the one errorFormatter produced
    Given a mock whose route "GET /api/fail" throws "boom" and an exchange observer
    And the mock intercepts fetch with an errorFormatter that returns:
      """
      { "formatted": true }
      """
    When the app fetches "http://localhost/api/fail"
    Then the observed exchange was answered with status 500
    And the observed response body is:
      """
      { "formatted": true }
      """

  Scenario: An unrouted request answered with 404 is observed
    Given a mock with route "GET /api/users" returning users and an exchange observer
    And the mock intercepts fetch with passthrough disabled
    When the app fetches "http://localhost/api/missing"
    Then the number of observed exchanges is 1
    And the observed exchange was answered with status 404
    And the observed response body has code "ROUTE_NOT_FOUND"

  Scenario: A malformed JSON body answered with 400 is observed with its raw text
    Given a mock with route "POST /api/users" echoing the body and an exchange observer
    And the mock intercepts fetch with passthrough disabled
    When the app posts the JSON text "{oops" to "http://localhost/api/users"
    Then the observed exchange was answered with status 400
    And the observed request body is the text "{oops"
    And the observed response body has code "MALFORMED_JSON"

  Scenario: A request passed on to the network is not observed
    Given a mock with route "GET /api/users" returning users and an exchange observer
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/other"
    Then the network answered the fetch
    And the number of observed exchanges is 0

  Scenario: Only the mock that answered observes the exchange
    Given a mock "answering" with route "GET /api/users" returning users and an exchange observer
    And a mock "missing" with no routes and an exchange observer
    And mock "answering" intercepts fetch
    And mock "missing" intercepts fetch
    When the app fetches "http://localhost/api/users"
    Then the number of exchanges mock "answering" observed is 1
    And the number of exchanges mock "missing" observed is 0

  Scenario: Nested leases of one mock produce one observation
    Given a mock with route "GET /api/users" returning users and an exchange observer
    And the mock intercepts fetch twice
    When the app fetches "http://localhost/api/users"
    Then the number of observed exchanges is 1

  Scenario: A rejected fetch is observed as failed with the same error
    Given a mock with route "GET /api/users" returning users and an exchange observer
    And the mock intercepts fetch with a beforeResponse hook that throws "hook failed"
    When the app fetches "http://localhost/api/users" expecting a rejection
    Then the fetch rejected with the message "hook failed"
    And the observed exchange failed with the error the fetch rejected with

  Scenario: Aborting a request the mock is answering is observed as aborted
    Given a mock with route "GET /api/slow" that waits until released and an exchange observer
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/slow" and aborts it while the route runs
    Then the fetch rejected with an AbortError
    And the observed exchange was aborted

  Scenario: An abort while another mock is still deciding is not observed
    Given a mock "answering" with route "GET /api/users" returning users and an exchange observer
    And a mock "deciding" with no routes and an exchange observer
    And mock "answering" intercepts fetch
    And mock "deciding" intercepts fetch with a beforeRequest hook that never settles
    When the app fetches "http://localhost/api/users" and aborts it while the hook is pending
    Then the fetch rejected with an AbortError
    And the number of exchanges mock "answering" observed is 0
    And the number of exchanges mock "deciding" observed is 0

  Scenario: A throwing observer changes neither the response nor other observers
    Given a mock with route "GET /api/users" returning users, an observer that throws "observer failed" and an exchange observer
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/users"
    Then the fetch caller received status 200
    And the number of observed exchanges is 1

  Scenario: Each observer receives its own frozen copy of the exchange
    Given a mock whose route "POST /api/users" stores the posted user, an observer that renames the observed user to "Mallory" and an exchange observer
    And the mock intercepts fetch
    When the app posts the JSON user "Ada" to "http://localhost/api/users"
    Then the stored user is still named "Ada"
    And the exchange observer saw the user named "Ada"
    And the observed exchange, its request headers and its response headers are frozen

  Scenario: Requests handled directly through mock.handle are not observed
    Given a mock with route "GET /api/users" returning users and an exchange observer
    When the test calls handle for "GET /api/users"
    Then the number of observed exchanges is 0

  Scenario: Observation stops after reset while the interception lease remains
    Given a mock with route "GET /api/users" returning users and an exchange observer
    And the mock intercepts fetch
    When the mock is reset and its route is defined again
    And the app fetches "http://localhost/api/users"
    Then the fetch caller received status 200
    And the number of observed exchanges is 0

  Scenario: An exchange in flight across a reset is not observed
    Given a mock with route "GET /api/slow" that waits until released and an exchange observer
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/slow" and the mock is reset and given a fresh exchange observer before the route is released
    Then the in-flight fetch still answered status 200
    And neither observer saw an exchange

  Scenario: An observer piped after a request arrived does not see it
    Given a mock with route "GET /api/slow" that waits until released
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/slow" and an exchange observer is piped before the route is released
    Then the fetch caller received status 200
    And the number of observed exchanges is 0

  Scenario: The observed exchange spans the route's delay
    Given a mock with route "GET /api/slow" delayed by 50 ms and an exchange observer
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/slow"
    Then the observed exchange lasted at least 40 ms

  Scenario: pipe rejects an onExchange that is not a function
    When a plugin with a process function and an onExchange set to the string "yes" is piped
    Then pipe throws a SchmockError with code "PLUGIN_INVALID" and reason "onExchange must be a function when set"
