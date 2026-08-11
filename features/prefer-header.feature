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
    Then the response body "id" is a number
    And the response body "name" is a string

  Scenario: Prefer example selects from the negotiated media type
    Given a mock with media-specific named examples
    When I request the text example with Prefer and Accept headers
    Then the preferred response body is "plain-example"
    And the preferred response content type is "text/plain"
