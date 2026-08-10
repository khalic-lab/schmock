Feature: Fetch Interceptor
  As a developer using Schmock in a browser or Node.js environment
  I want to intercept fetch calls and route them through Schmock
  So that I can mock API responses without a running server

  Scenario: Intercept a matched fetch request
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted
    When I fetch "/api/users"
    Then the fetch response status should be 200
    And the fetch response body should be the mocked users

  Scenario: A literal unicode route is matched by both URL spellings
    Given a Schmock instance with route "GET /café/:name" returning the captured name
    And fetch is intercepted with passthrough enabled
    When I fetch the literal unicode URL and the percent-encoded URL
    Then both fetch responses should be 200 with the decoded captured name
    And the original fetch should not have been called

  Scenario: Passthrough for unmatched routes
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted with passthrough enabled
    When I fetch "/api/other"
    Then the original fetch should have been called

  Scenario: Passthrough disabled returns 404
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted with passthrough disabled
    When I fetch "/api/other"
    Then the fetch response status should be 404

  Scenario: Restore puts original fetch back
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted
    When I restore the interceptor
    Then globalThis.fetch should be the original function

  Scenario: BaseUrl filters which requests are intercepted
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted with baseUrl "/api"
    When I fetch "/other/endpoint"
    Then the original fetch should have been called

  Scenario: Origin-form baseUrl intercepts matching origin only
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted with baseUrl "https://api.example.com"
    When I fetch "https://api.example.com/api/users"
    Then the response status should be 200
    And the fetch response body should be the mocked users
    And the original fetch should not have been called
    When I fetch "https://other.example.com/api/users"
    Then the original fetch should have been called exactly once for "https://other.example.com/api/users"

  Scenario: Origin-form baseUrl with a path prefix requires both to match
    Given a Schmock instance with route "GET /v1/users" returning users
    And fetch is intercepted with baseUrl "https://api.example.com/v1"
    When I fetch "https://api.example.com/v1/users"
    Then the response status should be 200
    And the fetch response body should be the mocked users
    And the original fetch should not have been called
    When I fetch "https://api.example.com/users"
    Then the original fetch should have been called exactly once for "https://api.example.com/users"

  Scenario: beforeRequest hook modifies the request
    Given a Schmock instance with route "GET /api/users" that reads headers
    And fetch is intercepted with a beforeRequest hook that adds a header
    When I fetch "/api/users"
    Then the response should contain the injected header value

  Scenario: beforeResponse hook modifies the response
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted with a beforeResponse hook that adds a header
    When I fetch "/api/users"
    Then the fetch response should have the injected header

  Scenario: One mock holds two concurrent leases
    Given a Schmock instance with a route under each of two base URLs
    And the same mock intercepts fetch twice with different base URLs
    When I fetch through each lease
    Then each lease should serve its own base URL
    When I restore the newer lease
    Then the older lease should still serve its own base URL
    When I restore the older lease
    Then globalThis.fetch should be the original function

  Scenario: Two leases of one mock report a single unmatched request
    Given a Schmock instance with lifecycle listeners and a route
    And the same mock intercepts fetch twice
    When I fetch an unmatched route
    Then the lifecycle events should fire exactly once

  Scenario: Updating lease options preserves stack position
    Given an older mock and a newer mock both serving "GET /api/shared"
    When the older lease updates its options in place
    Then the newer mock should still win the shared route
    And the older lease should apply its updated options

  Scenario: Multiple mocks compose from newest to oldest
    Given an older mock for both routes and a newer mock for "GET /api/shared"
    And both mocks intercept fetch in that order
    When I fetch the shared and older routes
    Then the shared route should use the newer mock
    And the older route should fall through to the older mock

  Scenario: Interceptors can be restored out of order
    Given an older mock and a newer mock both intercepting fetch
    When I restore the older interceptor first
    Then the newer interceptor should remain active
    When I restore the newer interceptor
    Then globalThis.fetch should be the original function

  Scenario: Restore preserves a third-party fetch replacement
    Given fetch is intercepted
    When another library replaces globalThis.fetch
    And I restore the interceptor
    Then the third-party fetch replacement should remain installed

  Scenario: RequestInit overrides the input Request
    Given an intercepted route that reports the effective fetch request
    When I fetch a Request with overriding method headers and body
    Then the route should receive the overriding request values

  Scenario: Relative URL fragments do not affect routing
    Given an intercepted route at "/fragmented"
    When I fetch the relative URL "fragmented#ignored"
    Then the fragmented route should return the mocked response

  Scenario: Text request bodies are not parsed as JSON
    Given an intercepted route that reports its request body type
    When I fetch it with a JSON-looking text body
    Then the route should receive a string body

  Scenario: Pre-aborted requests do not enter the mock
    Given an intercepted route that records generator executions
    When I fetch it with a pre-aborted signal
    Then fetch should reject with an abort error
    And the aborted request should not execute or enter history

  Scenario: Reset preserves an explicitly acquired interceptor
    Given an intercepted route returning the first generation
    When I reset and re-register the intercepted route
    Then the interceptor handle should remain active
    And a fetch should return the second generation
    When I restore the surviving interceptor
    Then globalThis.fetch should be the original function

  Scenario: Relative URLs use the browser base URI
    Given a browser base URI and an intercepted route beneath it
    When I fetch a document-relative route
    Then the route beneath the browser base should respond

  Scenario: Malformed JSON can pass through unchanged
    Given an unmatched intercepted JSON request with a passthrough backend
    When I fetch malformed JSON for the unmatched route
    Then the passthrough backend should receive the exact malformed body
    And the malformed passthrough should not be formatted or recorded

  Scenario: Abort settles while an interceptor hook remains pending
    Given an intercepted request paused in an async hook
    When I abort the request without releasing the hook
    Then fetch should settle with an abort error before the hook is released

  Scenario: Passthrough uses the admitted request snapshot
    Given an unmatched request paused before passthrough
    When I mutate its caller-owned headers before releasing it
    Then passthrough should receive the original header snapshot

  Scenario: Strict unmatched HEAD responses are bodyless
    Given fetch is intercepted with passthrough disabled
    When I fetch an unmatched HEAD route
    Then the fetch response status should be 404
    And the unmatched HEAD response body should be empty

  Scenario: A generator exception reaches the error formatter
    Given an intercepted route whose generator throws
    When I fetch the throwing route
    Then the fetch response status should be 500
    And the formatted error body should be returned
    And the error formatter should have been called once

  Scenario: A cloning beforeResponse hook keeps exception provenance
    Given an intercepted throwing route with a spreading beforeResponse hook
    When I fetch the throwing route
    Then the fetch response status should be 500
    And the formatted error body should be returned

  Scenario: An ordinary 500 route response is not reformatted
    Given an intercepted route returning a plain 500 error body
    When I fetch the plain error route
    Then the fetch response status should be 500
    And the plain error body should be returned unchanged
    And the error formatter should not have been called

  Scenario: A beforeResponse hook that rewrites an exception status is honoured
    Given an intercepted throwing route with a beforeResponse hook that rewrites the status
    When I fetch the throwing route
    Then the fetch response status should be 503
    And the error formatter should not have been called
