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

  Scenario: Double intercept throws an error
    Given a Schmock instance with route "GET /api/users" returning users
    And fetch is intercepted
    When I try to intercept again
    Then it should throw an error about already intercepting

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
