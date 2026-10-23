Feature: OpenAPI spec loading
  As a developer loading an OpenAPI spec I do not fully trust
  I want reading the spec to stay inside what the spec and my options say
  So that a crafted spec cannot corrupt the process, stall it or reach the network unasked

  Scenario: A $ref through an inherited name is refused
    Given a spec whose discriminator is a reference to "#/__proto__"
    When I create an openapi plugin from the spec expecting a failure
    Then creating the plugin fails with code "OPENAPI_INVALID_REF"
    And no object in the process gained the discriminator marker
