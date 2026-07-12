Feature: Validation Plugin
  As an API developer
  I want to validate request and response bodies against JSON Schema
  So that my mocks enforce API contracts

  Scenario: Valid request body passes validation
    Given I create a validated mock that requires name and email
    When I send a valid POST with name "John" and email "john@test.com"
    Then the status should be 201
    And the response body should have property "name" with value "John"

  Scenario: Invalid request body returns 400
    Given I create a validated mock that requires name and email
    When I send an invalid POST missing required fields
    Then the status should be 400
    And the response body should have error code "REQUEST_VALIDATION_ERROR"

  Scenario: Required body flag works without a request schema
    Given I create a validated mock with body required but no body schema
    When I send the POST without a body
    Then the status should be 400
    And the response body should have error code "REQUEST_VALIDATION_ERROR"
    And the validated generator should not have executed

  Scenario: Request rejection is not replaced by response validation
    Given I create a mock with incompatible request and response validation
    When I send an invalid POST to the combined validator
    Then the status should be 400
    And the response body should have error code "REQUEST_VALIDATION_ERROR"
    And the validated generator should not have executed

  Scenario: Invalid response body returns 500
    Given I create a mock with response validation that expects a number id
    When I request the endpoint
    Then the status should be 500
    And the response body should have error code "RESPONSE_VALIDATION_ERROR"

  Scenario: Valid response passes validation
    Given I create a mock with valid response and response validation
    When I request the endpoint
    Then the status should be 200
    And the response body should have property "id" with numeric value

  Scenario: Structured response object validates its semantic body
    Given I create a mock returning a structured response with a valid numeric id
    When I request the structured response endpoint
    Then the status should be 202
    And the response body should have property "id" with numeric value
    And the response header "x-response-shape" should be "structured"

  Scenario: Undefined semantic response body is validated
    Given I create a mock returning an undefined body against a null response schema
    When I request the undefined response endpoint
    Then the status should be 500
    And the response body should have error code "RESPONSE_VALIDATION_ERROR"

  Scenario: Header validation rejects missing required headers
    Given I create a mock requiring an authorization header
    When I request without authorization header
    Then the status should be 400
    And the response body should have error code "HEADER_VALIDATION_ERROR"

  Scenario: Header validation passes with required headers
    Given I create a mock requiring an authorization header
    When I request with authorization header "Bearer token123"
    Then the status should be 200

  Scenario: Query parameter validation
    Given I create a mock requiring page query parameter
    When I request with query page "1"
    Then the status should be 200
    When I request without required query parameter
    Then the invalid query status should be 400
    And the invalid query response should have error code "QUERY_VALIDATION_ERROR"

  Scenario: Custom error status codes
    Given I create a validated mock with custom error status 422
    When I send an invalid request body
    Then the status should be 422

  Scenario: Email format validation rejects malformed strings
    Given I create a mock validating email format on the email field
    When I send a POST with email "not-an-email"
    Then the status should be 400
    And the response body should have error code "REQUEST_VALIDATION_ERROR"

  Scenario: Email format validation accepts well-formed addresses
    Given I create a mock validating email format on the email field
    When I send a POST with email "user@example.com"
    Then the status should be 201
