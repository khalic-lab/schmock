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

  Scenario: Empty Bearer token returns 401
    Given a mock with a spec requiring Bearer auth
    When I request with Authorization header "Bearer "
    Then the response status is 401

  Scenario: API key in header is validated
    Given a mock with a spec requiring an API key header
    When I request without the API key header
    Then the response status is 401

  Scenario: Valid API key passes through
    Given a mock with a spec requiring an API key header
    When I request with the API key header present
    Then the response status is 200

  Scenario: API key in query is validated
    Given a mock with a spec requiring an API key query parameter
    When I request without the API key query parameter
    Then the response status is 401

  Scenario: Valid API key query passes through
    Given a mock with a spec requiring an API key query parameter
    When I request with the API key query parameter present
    Then the response status is 200

  Scenario: API key in a cookie is validated
    Given a mock with a spec requiring an API key cookie
    When I request without the API key cookie
    Then the response status is 401

  Scenario: Valid API key cookie passes through
    Given a mock with a spec requiring an API key cookie
    When I request with the API key cookie present
    Then the response status is 200

  Scenario: Basic auth is validated
    Given a mock with a spec requiring Basic auth
    When I request without an Authorization header
    Then the response status is 401
    And the response has a WWW-Authenticate header with "Basic"

  Scenario: Empty Basic credentials return 401
    Given a mock with a spec requiring Basic auth
    When I request with Authorization header "Basic "
    Then the response status is 401

  Scenario: Public endpoint skips validation
    Given a mock with a spec where one endpoint is public
    When I request the public endpoint without auth
    Then the response status is 200

  Scenario: Unauthorized creation does not mutate the collection
    Given a mock with a protected CRUD spec
    When I create an item without auth
    And I list the items with valid auth
    Then the create response status is 401
    And the protected collection is empty

  Scenario: An earlier request guard cannot be rewritten as success
    Given an external guard before an OpenAPI plugin
    When I request the guarded OpenAPI route preferring status 200
    Then the guarded OpenAPI response status is 403
