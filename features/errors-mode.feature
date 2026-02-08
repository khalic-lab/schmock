Feature: Errors Mode
  As a developer
  I want request body validation against the spec
  So that my mock rejects invalid payloads like the real API

  Scenario: Invalid request body returns 400 with validation errors
    Given a mock with validateRequests enabled
    When I POST an invalid body to a route with a requestBody schema
    Then the response status is 400
    And the error body has a "details" array

  Scenario: Valid request body passes through
    Given a mock with validateRequests enabled
    When I POST a valid body to a route with a requestBody schema
    Then the response status is 201
