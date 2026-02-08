Feature: Admin API
  As a developer
  I want runtime admin endpoints for inspection
  So that I can debug and manage the mock server

  Scenario: List registered routes
    Given a CLI server with admin enabled and a simple spec
    When I request "GET /schmock-admin/routes"
    Then the response status is 200
    And the response body is an array of route objects

  Scenario: Inspect server state
    Given a CLI server with admin enabled and a simple spec
    When I request "GET /schmock-admin/state"
    Then the response status is 200
    And the response body is a state object

  Scenario: Reset the mock via admin
    Given a CLI server with admin enabled and a simple spec
    When I send "POST /schmock-admin/reset"
    Then the response status is 204

  Scenario: View request history
    Given a CLI server with admin enabled and a simple spec
    When I make a request to the mock API
    And I request "GET /schmock-admin/history"
    Then the response status is 200
    And the response body is an array

  Scenario: Admin routes are 404 without flag
    Given a CLI server without admin enabled
    When I request "GET /schmock-admin/routes"
    Then the response status is 404
