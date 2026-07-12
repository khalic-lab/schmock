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

  Scenario: Rejected content type does not run the route generator
    Given a mock with a spec defining JSON CRUD responses
    When I create an item requesting XML
    And I list the JSON items
    Then the create response status is 406
    And the negotiated collection is empty

  Scenario: Media types from another status are not accepted
    Given a mock whose success is JSON but error is XML
    When I request with Accept header "application/xml"
    Then the response status is 406

  Scenario: Error responses negotiate their own declared media type
    Given a CRUD mock whose success is JSON and missing response is problem JSON
    When I read a missing negotiated item requesting problem JSON
    Then the negotiated missing response status is 404
    And the negotiated missing content type is "application/problem+json"
