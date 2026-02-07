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

  Scenario: Numeric array response is not misinterpreted as status tuple
    Given I create a mock returning numeric array with response validation
    When I request the numeric array endpoint
    Then the status should be 200
    And the response body should be the array [1, 2, 3]
