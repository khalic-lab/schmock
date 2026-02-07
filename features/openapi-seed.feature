Feature: OpenAPI Seed Data

  As a developer
  I want to pre-populate mock data from various sources
  So that my tests start with a known state

  Scenario: Seed with inline objects
    Given a mock with Petstore spec and inline seed data
    When I list all pets
    Then the list contains 2 items

  Scenario: Seed with auto-generated data
    Given a mock with Petstore spec and auto-generated seed of 5 pets
    When I list all seeded pets
    Then the seeded list contains 5 items

  Scenario: Auto-increment IDs continue after seed
    Given a mock with Petstore spec and inline seed data
    When I create a new pet named "NewPet"
    Then the new pet ID is greater than existing seed IDs
