Feature: OpenAPI spec loading
  As a developer loading an OpenAPI spec I do not fully trust
  I want reading the spec to stay inside what the spec and my options say
  So that a crafted spec cannot corrupt the process, stall it or reach the network unasked

  Scenario: A $ref through an inherited name is refused
    Given a spec whose discriminator is a reference to "#/__proto__"
    When I create an openapi plugin from the spec expecting a failure
    Then creating the plugin fails with code "OPENAPI_INVALID_REF"
    And no object in the process gained the discriminator marker

  Scenario: A $ref pointer with too many tokens is refused
    Given a spec whose response schema is a reference with 100 tokens
    When I create an openapi plugin from the spec expecting a failure
    Then creating the plugin fails with code "OPENAPI_INVALID_REF"

  Scenario: A $ref to nothing fails with a coded error
    Given a spec whose response schema is a reference to "#/components/schemas/Missing"
    When I create an openapi plugin from the spec expecting a failure
    Then creating the plugin fails with code "OPENAPI_INVALID_REF"
    And the failure names the missing token "Missing"

  Scenario: Discriminator branches that are component objects agree across builds
    Given an inline spec whose discriminator branches are the component objects themselves
    When I request "/pets" from a mock made by the Node build and by the browser build
    Then both builds answer with the same pet
    And the pet's discriminator names one of the components
