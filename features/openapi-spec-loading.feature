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

  Scenario: A spec URL is not fetched under the default reference policy
    Given fetch records every request instead of sending it
    When I create an openapi plugin from the spec URL "https://specs.example.test/openapi.json" expecting a failure
    Then creating the plugin fails with code "OPENAPI_EXTERNAL_REF_BLOCKED"
    And nothing was fetched

  Scenario: A protocol-relative $ref is refused by the reference policy
    Given a spec whose response schema is a reference to "//169.254.169.254/latest/meta-data"
    When I create an openapi plugin with external references enabled expecting a failure
    Then creating the plugin fails with code "OPENAPI_EXTERNAL_REF_BLOCKED"

  Scenario: A seed path that is not a regular file is refused
    Given the Petstore spec with "pets" seeded from "/dev/null"
    When I create the seeded openapi plugin expecting a failure
    Then creating the plugin fails with code "OPENAPI_INVALID_OPTION"
    And the failure says the seed file is not a regular file
