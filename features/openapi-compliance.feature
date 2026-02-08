Feature: OpenAPI Response Compliance

  As a developer
  I want responses to match what the OpenAPI spec defines
  So that my mocks accurately reflect the real API contract

  Scenario: Wrapped list response with allOf composition
    Given a mock with the Scalar Galaxy spec loaded
    When I list all planets
    Then the response status is 200
    And the list body has a "data" property with an array
    And the list body has a "meta" property

  Scenario: Wrapped list response with inline object
    Given a mock with a Stripe-style spec loaded
    When I list all customers
    Then the response status is 200
    And the list body has a "data" property with an array
    And the list body has an "object" property equal to "list"

  Scenario: Flat list response for plain array spec
    Given a mock with the Petstore spec loaded
    When I list all pets
    Then the response status is 200
    And the list body is a flat array

  Scenario: Spec-defined error response schema
    Given a mock with the Scalar Galaxy spec loaded
    When I read planet with id 999
    Then the response status is 404
    And the error body has a "title" property
    And the error body has a "status" property

  Scenario: Default error format when no error schema defined
    Given a mock with the Petstore spec loaded
    When I read pet with id 999
    Then the response status is 404
    And the error body has property "error" equal to "Not found"
    And the error body has property "code" equal to "NOT_FOUND"

  Scenario: Response headers from spec definitions
    Given a mock with the Scalar Galaxy spec and seed data
    When I list all planets
    Then the response status is 200
    And the response has header "X-Request-ID"
    And the response has header "X-Pagination-Total"

  Scenario: Manual override forces wrapping on a flat-array spec
    Given a mock with the Petstore spec and listWrapProperty "items" override
    When I list all pets
    Then the response status is 200
    And the list body has a "items" property with an array

  Scenario: Manual override forces flat on a wrapped spec
    Given a mock with the Scalar Galaxy spec and listFlat override
    When I list all planets
    Then the response status is 200
    And the list body is a flat array

  Scenario: Manual errorSchema override replaces auto-detected error format
    Given a mock with the Petstore spec and custom error schema override
    When I read pet with id 999
    Then the response status is 404
    And the error body has a "message" property
    And the error body has a "statusCode" property

  Scenario: Debug mode logs detection results
    Given a mock with the Petstore spec and debug enabled
    Then the debug output contains "CRUD resources"
    And the debug output contains "pets"
