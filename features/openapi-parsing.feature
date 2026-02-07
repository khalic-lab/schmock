Feature: OpenAPI Spec Parsing

  As a developer
  I want to parse OpenAPI/Swagger specs
  So that routes are auto-registered from the spec

  Scenario: Parse Swagger 2.0 spec
    Given a Swagger 2.0 Petstore spec
    When I create an openapi plugin from the spec
    Then the parsed spec has title "Petstore"
    And the parsed spec has version "1.0.0"
    And the parsed spec has basePath "/api"

  Scenario: Parse OpenAPI 3.0 spec
    Given an OpenAPI 3.0 Petstore spec
    When I create an openapi plugin from the spec
    Then the parsed spec has title "Petstore"
    And the parsed spec has version "2.0.0"
    And routes are auto-registered from the spec

  Scenario: Parse inline spec object
    Given an inline OpenAPI spec object
    When I create an openapi plugin from the inline spec
    Then routes are registered from the inline spec
