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
