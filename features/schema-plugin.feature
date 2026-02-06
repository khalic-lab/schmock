Feature: Schema Plugin
  As a developer using Schmock with JSON Schema
  I want the schema plugin to generate valid mock data
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

  Scenario: Multiple schema plugin instances do not share state
    Given I create two separate schema plugin instances
    When I generate data from both instances
    Then the data from each instance should be independently generated

  Scenario: Invalid schema is rejected at plugin creation time
    Given I attempt to create a schema plugin with invalid schema
    Then it should throw a SchemaValidationError

  Scenario: Faker method validation checks actual method existence
    Given I attempt to create a schema with faker method "person.nonExistentMethod"
    Then it should throw a SchemaValidationError with message "Invalid faker method"
