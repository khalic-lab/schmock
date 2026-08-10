Feature: OpenAPI Spec Parsing

  As a developer
  I want to parse OpenAPI/Swagger specs
  So that routes are auto-registered from the spec

  Scenario: Parse Swagger 2.0 spec
    Given a Swagger 2.0 Petstore spec
    When I create an openapi plugin from the spec
    Then the parsed spec has title "Petstore"
    And the parsed spec has version "1.0.0"

  Scenario: Swagger 2.0 basePath does not prefix registered routes
    Given a Swagger 2.0 Petstore spec declaring basePath "/api"
    When I create a mock from the Swagger 2.0 spec
    Then a request to "/pets" succeeds
    And a request to "/api/pets" is not found

  Scenario: External file references resolve relative to the spec file
    Given a spec in a subdirectory referencing a sibling schema file
    When I parse it with external references enabled
    Then the referenced schema is inlined
    And no network request was attempted

  Scenario: External references are rejected by default
    Given a spec in a subdirectory referencing a sibling schema file
    When I parse it with default reference settings
    Then parsing fails with code "OPENAPI_EXTERNAL_REF_BLOCKED"

  Scenario: Parse OpenAPI 3.0 spec
    Given an OpenAPI 3.0 Petstore spec
    When I create an openapi plugin from the spec
    Then the parsed spec has title "Petstore"
    And the parsed spec has version "2.0.0"
    And routes are auto-registered from the spec

  Scenario: Route metadata carries operationId and tags
    Given an OpenAPI 3.0 spec with operationId "listPets" and tag "pets"
    When I handle a request through a metadata probe plugin
    Then the route metadata has operationId "listPets"
    And the route metadata has tag "pets"

  Scenario: Parse inline spec object
    Given an inline OpenAPI spec object
    When I create an openapi plugin from the inline spec
    Then routes are registered from the inline spec

  Scenario: A component schema referenced twice populates both properties
    Given a spec whose response references one component from two properties
    When I request the endpoint with dynamic generation
    Then both referenced properties are present
    And each referenced property carries its required label
