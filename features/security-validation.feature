Feature: Security Validation
  As a developer
  I want the mock to validate security schemes from the spec
  So that missing authentication is properly rejected

  Scenario: Missing Bearer token returns 401
    Given a mock with a spec requiring Bearer auth
    When I request without an Authorization header
    Then the response status is 401
    And the response has a WWW-Authenticate header with "Bearer"

  Scenario: Valid Bearer token returns 200
    Given a mock with a spec requiring Bearer auth
    When I request with Authorization header "Bearer my-token"
    Then the response status is 200

  Scenario: API key in header is validated
    Given a mock with a spec requiring an API key header
    When I request without the API key header
    Then the response status is 401

  Scenario: Valid API key passes through
    Given a mock with a spec requiring an API key header
    When I request with the API key header present
    Then the response status is 200

  Scenario: Basic auth is validated
    Given a mock with a spec requiring Basic auth
    When I request without an Authorization header
    Then the response status is 401
    And the response has a WWW-Authenticate header with "Basic"

  Scenario: Public endpoint skips validation
    Given a mock with a spec where one endpoint is public
    When I request the public endpoint without auth
    Then the response status is 200
