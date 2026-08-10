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
