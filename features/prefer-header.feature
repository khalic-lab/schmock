Feature: Prefer Header
  As a developer
  I want to use the Prefer header to control responses
  So that I can test different API scenarios easily

  Scenario: Prefer code returns specific status code
    Given a mock with an OpenAPI spec with 200 and 404 responses
    When I request with Prefer header "code=404"
    Then the response status is 404

  Scenario: Prefer example returns named example
    Given a mock with an OpenAPI spec with named examples
    When I request with Prefer header "example=dog"
    Then the response body name is "Buddy"

  Scenario: Prefer dynamic regenerates from schema
    Given a mock with an OpenAPI spec with a response schema
    When I request with Prefer header "dynamic=true"
    Then the response body has a "name" property
    And the response body has an "id" property
