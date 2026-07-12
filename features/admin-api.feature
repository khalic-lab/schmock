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
