Feature: Deterministic Seeds
  As a developer
  I want to seed the random generation
  So that I get reproducible mock data

  Scenario: Same seed produces same output
    Given a schema plugin with seed 42
    When I generate data twice with the same seed
    Then both outputs are identical

  Scenario: Different seeds produce different output
    Given a schema plugin using seeds 42 and 43
    When I generate data once with each seed
    Then the differently seeded outputs are distinct

  Scenario: Seeded arrays are reproducible without repeating every item
    Given an array schema plugin with seed 42 and count 5
    When I generate the seeded array twice
    Then both seeded arrays are identical
    And the seeded array contains varied items
