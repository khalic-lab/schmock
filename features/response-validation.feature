Feature: OpenAPI Response Validation
  As a developer
  I want generated responses validated against the matching OpenAPI response
  So that status and media-type specific contract violations are visible

  Scenario: Valid response passes validation
    Given a mock with response validation enabled
    When I request a valid generated response
    Then the response status is 200

  Scenario: Response validation uses the actual status
    Given a mock with status-specific response schemas
    When I request status 201 with a body valid only for status 200
    Then the response status is 500
    And the response validation error code is "RESPONSE_VALIDATION_ERROR"

  Scenario: Response validation uses the negotiated media type
    Given a mock with media-type-specific response schemas
    When I request a response as "application/problem+json"
    Then the response status is 500
    And the response validation error code is "RESPONSE_VALIDATION_ERROR"

  Scenario: Generated responses use the negotiated media-type schema
    Given a mock generating media-type-specific responses
    When I request a response as "application/problem+json"
    Then the response status is 200
    And the generated response has a non-empty "error" field

  Scenario: Explicit response Content-Type parameters select the matching schema
    Given a validating mock with explicit profile response content type
    When I request explicit response profile "b"
    Then the response status is 200
    And the explicit profile response marker is "b"
    And the explicit response content type is "application/json;profile=b"

  Scenario: Generated Content-Type selects static and CRUD response schemas
    Given a validating mock with profile-labelled static and CRUD responses
    When I request both profile-labelled responses without Accept
    Then both profile-labelled responses succeed
    And both profile-labelled bodies use profile "b"
    And both profile-labelled responses declare "application/json;profile=b"

  Scenario: Response validation supports status class wildcards
    Given a mock with a validated 2XX response
    When I request status 201 covered by the wildcard
    Then the response status is 201

  Scenario: Response validation falls back to the default response
    Given a mock with a validated default response
    When I request undeclared status 418
    Then the response status is 418

  Scenario: Standard OpenAPI formats compile and validate
    Given a mock with a validated UUID response
    When I request the UUID response
    Then the response status is 200
    And the generated response is a UUID

  Scenario: Schema-less media does not inherit another representation's schema
    Given a mock whose JSON response has a schema and text response has none
    When I request the schema-less text response
    Then the response status is 200
    And the text response does not contain the JSON-only field

  Scenario: Nullable request field accepts an explicit null
    Given a mock with request validation and a nullable request field
    When I post an explicit null for the nullable field
    Then the response status is 200
    And the response is not a validation error

  Scenario: Nullable response field passes response validation when generated as null
    Given a mock with response validation and a seeded nullable response field
    When I request the seeded nullable response
    Then the response status is 200
    And the nullable response field is null
