Feature: Content Negotiation
  As a developer
  I want the mock to respect the Accept header
  So that unsupported content types are properly rejected

  Scenario: JSON accepted returns 200
    Given a mock with a spec defining JSON responses
    When I request with Accept header "application/json"
    Then the response status is 200

  Scenario: Unsupported content type returns 406
    Given a mock with a spec defining JSON responses
    When I request with Accept header "application/xml"
    Then the response status is 406
    And the error body has an "acceptable" array

  Scenario: Wildcard Accept passes through
    Given a mock with a spec defining JSON responses
    When I request with Accept header "*/*"
    Then the response status is 200

  Scenario: No Accept header defaults to success
    Given a mock with a spec defining JSON responses
    When I request without an Accept header
    Then the response status is 200
