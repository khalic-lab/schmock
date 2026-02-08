Feature: Deterministic Seeds
  As a developer
  I want to seed the random generation
  So that I get reproducible mock data

  Scenario: Same seed produces same output
    Given a schema plugin with seed 42
    When I generate data twice with the same seed
    Then both outputs are identical

  Scenario: Different seeds produce different output
    Given a schema plugin with seed 42
    And a schema plugin with seed 99
    When I generate data from each
    Then the outputs are different
