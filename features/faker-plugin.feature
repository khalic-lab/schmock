Feature: Faker Plugin
  As a developer using Schmock with JSON Schema
  I want the faker plugin to generate valid mock data
  So that my tests have realistic and type-safe data

  Scenario: Generate object from simple schema
    Given I create a schema plugin with:
      """
      {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "age": { "type": "integer" }
        },
        "required": ["name", "age"]
      }
      """
    When I generate data from the schema
    Then the generated data should have property "name" of type "string"
    And the generated data should have property "age" of type "number"

  Scenario: Generate array of items with explicit count
    Given I create a schema plugin for array with count 5:
      """
      {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": { "type": "integer" }
          },
          "required": ["id"]
        }
      }
      """
    When I generate data from the schema
    Then the generated data should be an array of length 5

  Scenario: Template preserves string values for mixed templates
    Given I create a schema plugin with template override "user-{{params.id}}"
    When I generate data with param "id" set to "42"
    Then the template result should be the string "user-42"

  Scenario: Generate tuple positions from their respective schemas
    Given I create a tuple schema with string, integer, and boolean positions
    When I generate data from the schema
    Then the generated tuple should contain string, number, and boolean values in order

  Scenario: Generate a nested tuple through a schema reference
    Given I create an object schema whose payload references a tuple definition
    When I generate data from the schema
    Then the generated payload tuple should contain string, number, and boolean values in order

  Scenario: Apply overrides to every generated array item
    Given I create an object array schema with count 3 and override name "fixed"
    When I generate data from the schema
    Then every generated array item should have name "fixed"

  Scenario: Generate useful text for an unconstrained string
    Given I create a schema plugin with:
      """
      {
        "type": "object",
        "properties": {
          "origin": { "type": "string" }
        },
        "required": ["origin"]
      }
      """
    When I generate data from the schema
    Then the generated data should have a non-empty "origin"

  Scenario: Declared constraints win over field name guesses
    Given I create a schema plugin with:
      """
      {
        "type": "object",
        "properties": {
          "email": { "type": "string", "format": "date-time" },
          "name": { "type": "string", "format": "ipv4" },
          "age": { "type": "integer", "multipleOf": 10 }
        },
        "required": ["email", "name", "age"]
      }
      """
    When I generate data from the schema with 20 different seeds
    Then every generated "email" should be an ISO date-time
    And every generated "name" should be an IPv4 address
    And every generated "age" should be a multiple of 10

  Scenario: Seeded generation repeats its dates as the clock advances
    Given I create a schema plugin with:
      """
      {
        "type": "object",
        "properties": {
          "createdAt": { "type": "string" }
        },
        "required": ["createdAt"]
      }
      """
    When I generate data with seed 42 five years apart
    Then both generations should hold the same valid date

  Scenario: Mutating a generated item leaves later requests untouched
    Given I create a schema plugin with:
      """
      {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "settings": { "type": "object", "default": { "theme": "dark" } }
          },
          "required": ["settings"]
        }
      }
      """
    When I generate two items and mutate the first item's settings
    Then the second item's settings should be unchanged
    And a fresh generation should return the original settings

  Scenario: Reject an explicit count whose output exceeds the node budget
    Given I create a 200-field array schema with count 10000
    When I create the faker plugin
    Then plugin creation should fail on the "generated_nodes" resource

  Scenario: Reject a string length before generation can allocate it
    Given I create a string schema longer than the supported maximum
    When I create the faker plugin
    Then plugin creation should fail on the "string_length" resource

  Scenario: Reject an indirect cycle through a local schema reference
    Given I create a local definition whose child references the same definition
    When I create the faker plugin
    Then plugin creation should fail with a circular schema error

  Scenario: Generate with object-form faker arguments
    Given I create an integer schema using object-form faker arguments from 1 to 2
    When I generate data from the schema
    Then the generated integer should be between 1 and 2

  Scenario: Reject malformed object-form faker arguments
    Given I create a faker object with two method keys
    When I create the faker plugin
    Then plugin creation should fail at the faker schema path

  Scenario: Ignore consumer json-schema-faker extensions
    Given a consumer defines a json-schema-faker extension
    When the consumer and Schmock generate from the contaminated schema
    Then only the consumer generation should use its extension

  Scenario: Reject a cycle through embedded schema IDs
    Given I create embedded schemas whose relative ID references form a cycle
    When I create the faker plugin
    Then plugin creation should fail with a circular schema error

  Scenario: Reject an oversized fixed string
    Given I create a string schema with an oversized const value
    When I create the faker plugin
    Then plugin creation should fail on the "string_length" resource

  Scenario: Reject an allocation-bearing faker length argument
    Given I create object-form string faker arguments with an oversized length
    When I create the faker plugin
    Then plugin creation should fail on the "string_length" resource

  Scenario: Reject an oversized object cardinality
    Given I create an object schema with an oversized minimum property count
    When I create the faker plugin
    Then plugin creation should fail on the "object_properties" resource

  Scenario: Ignore irrelevant string limits on an integer schema
    Given I create an integer schema with an irrelevant oversized maxLength
    When I generate data from the schema
    Then the generated value should be an integer from 1 to 2

  Scenario: Reject an oversized override after final processing
    Given I create a safe object schema with an oversized string override
    When I generate data and capture the failure
    Then generation should fail on the "string_length" resource

  Scenario: Reject allocation-bearing positional faker counts
    Given I create object-form word faker arguments with an oversized positional count
    When I create the faker plugin
    Then plugin creation should fail on the "string_length" resource

  Scenario: Validate schemas forwarded through modern keywords
    Given I hide an invalid faker method inside prefixItems
    When I create the faker plugin
    Then plugin creation should fail at the faker schema path

  Scenario: Reject duplicate canonical schema identifiers
    Given I create two embedded schemas with the same canonical ID
    When I create the faker plugin
    Then plugin creation should fail with a duplicate identifier error

  Scenario: Snapshot plugin options at factory creation
    Given I create a faker plugin and then mutate all of its source options
    When I process the snapshotted faker plugin
    Then it should use only the original schema count overrides and seed

  Scenario: Ignore consumer extensions colliding with standard schema keywords
    Given a consumer defines the json-schema-faker type keyword
    When the consumer and Schmock generate from the standard schema
    Then only the consumer generation should use its type extension
