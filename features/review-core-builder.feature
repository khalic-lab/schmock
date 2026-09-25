Feature: Core builder review fixes
  As a developer using Schmock
  I want the builder, its standalone server and its plugin lifecycle to behave predictably at the edges
  So that a mock never answers the wrong route, loses a lifecycle event or leaks one test into the next

  # ── Standalone server ingress ────────────────────────────────────────────

  Scenario: A double-slash request target is not read as a protocol-relative URL
    Given a listening mock with routes "GET /", "GET /bar" and "GET /users"
    When a raw client sends "GET //users"
    And a raw client sends "GET //foo/bar"
    Then both raw responses have status 404
    And the mock history is empty

  Scenario: The standalone server answers an unsupported method with 405
    Given a listening mock with routes "GET /", "GET /bar" and "GET /users"
    When a raw client sends "PROPFIND /users"
    Then the raw response status is 405 with code "METHOD_NOT_ALLOWED"
    And the raw response Allow header lists "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS"

  Scenario: The standalone server answers a request without a Host header with 400
    Given a listening mock with routes "GET /", "GET /bar" and "GET /users"
    When a raw HTTP/1.0 client sends "GET /users" without a Host header
    Then the raw response status is 400 with code "BAD_REQUEST"

  Scenario: The standalone server answers a malformed absolute request target with 400
    Given a listening mock with routes "GET /", "GET /bar" and "GET /users"
    When a raw client sends a GET whose absolute target has an unclosed IPv6 bracket
    Then the raw response status is 400 with code "BAD_REQUEST"

  Scenario: A server error after startup is reported instead of crashing the process
    Given a listening mock whose http server is captured
    When the captured server emits an error after startup
    Then the error is handled by a listener
    And the server still answers "GET /alive" with status 200

  # ── Request handling ─────────────────────────────────────────────────────

  Scenario: History records the request exactly as the client sent it
    Given a mock whose POST route mutates the request body, query and headers
    When I send a POST with body name "Ann", query a "1" and header h "v"
    Then the last history record shows the body, query and headers the client sent

  Scenario: A plugin editing static route data in place does not change later responses
    Given a mock with a static list route and a plugin that pushes into the response in place
    When I request the static list route three times
    Then every response contains exactly one pushed item

  Scenario: A plugin editing the route config in place does not change later requests
    Given a mock with a static route and a plugin that sets the route content type on the first request only
    When I request the static route twice
    Then the first response is "text/plain" and the second is "application/json"

  Scenario: A namespace configured with a trailing slash still serves its bare root
    Given a mock with namespace "/api/" and a route "GET /"
    When I request "/api", "/api/" and "/api/users"
    Then the statuses are 200, 200 and 404

  # ── Lifecycle events ─────────────────────────────────────────────────────

  Scenario: Aborting a request during its route delay emits one request:end with status 499
    Given a mock with a delayed route and a request:end listener
    When I abort a request to the delayed route while it waits
    Then the request rejects with an AbortError
    And exactly one request:end event with status 499 was emitted

  Scenario: Aborting a failing request during its delay emits one request:end with status 499
    Given a mock with a delayed failing route and a request:end listener
    When I abort a request to the delayed failing route while it waits
    Then the request rejects with an AbortError
    And exactly one request:end event with status 499 was emitted

  # ── Route registration ───────────────────────────────────────────────────

  Scenario: A route with the same shape as an existing one is reported as a duplicate
    Given a debug mock with "GET /users/:id" registered
    When I register "GET /users/:userId"
    Then a duplicate route warning is logged
    And getRoutes lists only "GET /users/:id"
    And a request to "/users/7" reaches the first route with id "7"

  # ── Plugin lifecycle ─────────────────────────────────────────────────────

  Scenario: pipe() rejects a plugin without a process hook
    Given a fresh mock for plugin validation
    When I pipe a plugin named "noproc" without a process hook
    Then pipe throws a SchmockError with code "PLUGIN_INVALID"
    And the mock still answers its route with status 200

  Scenario: Piping the same plugin object twice installs and runs it once
    Given a fresh debug mock for plugin validation
    When I pipe the same plugin object twice
    Then the second pipe is ignored with a duplicate plugin warning
    And the plugin was installed once and processes each request once

  Scenario: uninstall() cannot pipe plugins or register routes into the reset mock
    Given a mock with a plugin whose uninstall pipes a plugin and registers "GET /leftover"
    When I reset the mock with no request in flight
    And I register "GET /fresh" and request it
    Then the fresh response is untouched by any leftover plugin
    And "GET /leftover" is not registered
    And the uninstall hook saw its pipe() rejected with code "PLUGIN_UNINSTALL_OPERATION_UNSUPPORTED"

  Scenario: A deferred uninstall cannot register routes into the reset mock
    Given a mock with a plugin whose uninstall pipes a plugin and registers "GET /leftover"
    And a slow request is in flight
    When I reset the mock
    And I register "GET /fresh"
    And the slow request settles
    Then the fresh response is untouched by any leftover plugin
    And "GET /leftover" is not registered

  Scenario: Re-piping a plugin after reset runs its pending uninstall before the new install
    Given a mock with a counting plugin and a slow request in flight
    When I reset the mock
    And I pipe the same counting plugin again
    Then the plugin was uninstalled once before being installed again
    When the slow request settles
    Then the counting plugin is still live with 2 installs and 1 uninstall

  # ── Types ────────────────────────────────────────────────────────────────

  Scenario: isStatusTuple does not promise string-record headers
    Given a three-element tuple whose headers are null
    When I narrow it with isStatusTuple
    Then the narrowed headers element is typed unknown and is null at runtime

  Scenario: Response helpers carry literal statuses and paginate accepts readonly arrays
    Given a readonly list of 12 numbers
    When I paginate it with page 2 and page size 5
    Then the page holds 5 items starting at 6
    And notFound, badRequest, created and noContent return their literal statuses
