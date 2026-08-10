Feature: Admin API
  As a developer
  I want runtime admin endpoints for inspection
  So that I can debug and manage the mock server

  Scenario: List registered routes
    Given a CLI server with admin enabled and a simple spec
    When I request "GET /schmock-admin/routes"
    Then the response status is 200
    And the response body contains the exact registered routes

  Scenario: Inspect server state
    Given a CLI server with admin enabled and a simple spec
    When I request "GET /schmock-admin/state"
    Then the response status is 200
    And the response body is an empty state object

  Scenario: Reset the mock via admin
    Given a CLI server with admin enabled, state, and request history
    When I send "POST /schmock-admin/reset"
    Then the response status is 204
    And the admin request history is empty
    And the admin state is empty
    And the registered routes are unchanged
    And the mock API still responds

  Scenario: View request history
    Given a CLI server with admin enabled and a simple spec
    When I make a request to the mock API
    And I request "GET /schmock-admin/history"
    Then the response status is 200
    And the response body contains the exact recorded request

  Scenario: Admin routes are 404 without flag
    Given a CLI server without admin enabled
    When I request "GET /schmock-admin/routes"
    Then the response status is 404

  Scenario: Admin endpoints reject an unauthenticated request
    Given a CLI server with admin enabled and a simple spec
    When I request "GET /schmock-admin/history" without a token
    Then the response status is 401
    And the response body has code "UNAUTHORIZED"
    And the response carries a "www-authenticate" challenge
    And the response has no CORS headers

  Scenario: Admin endpoints reject a wrong token
    Given a CLI server with admin enabled and a simple spec
    When I request "GET /schmock-admin/history" with the token "not-the-token"
    Then the response status is 401
    And the response body has code "UNAUTHORIZED"

  Scenario: Admin endpoints accept the issued token
    Given a CLI server with admin enabled and a simple spec
    When I request "GET /schmock-admin/routes" with the issued token
    Then the response status is 200
    And the response body contains the exact registered routes

  Scenario: Admin responses carry no CORS headers even with CORS enabled
    Given a CLI server with admin and CORS enabled
    When I request "GET /schmock-admin/state" with the issued token
    Then the response status is 200
    And the response has no CORS headers
    And a browser preflight to "/schmock-admin/state" is refused with 403 and no CORS headers
    And a bare OPTIONS to "/schmock-admin/state" gets no CORS headers and is not 204
    And an unsupported method on "/schmock-admin/state" gets an error with no CORS headers

  Scenario: Admin refuses a browser-originated request
    Given a CLI server with admin enabled and a simple spec
    When I request "GET /schmock-admin/state" with the issued token and an Origin header
    Then the response status is 403
    And the response body has code "FORBIDDEN"
    And the response has no CORS headers

  Scenario: Admin history redacts sensitive request headers
    Given a CLI server with admin enabled and a simple spec
    When I make a request to the mock API with sensitive headers
    And I request "GET /schmock-admin/history" with the issued token
    Then the response status is 200
    And the recorded headers redact "authorization"
    And the recorded headers redact "cookie"
    And the recorded headers redact "x-schmock-admin-token"
    And the recorded headers keep "accept"

  Scenario: Admin history is capped by the configured limit
    Given a CLI server with admin enabled and a history limit of 2
    When I make 5 requests to the mock API
    And I request "GET /schmock-admin/history" with the issued token
    Then the response status is 200
    And the response body contains 2 history records
