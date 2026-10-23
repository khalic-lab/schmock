Feature: Faker creation-time checks
  As a developer mocking an API with Schmock
  I want a schema that json-schema-faker cannot generate cheaply or correctly
  to be refused when the faker plugin is created,
  so that it never passes creation and then fails or stalls on every request

  # Review 2026-10-23 faker-11: json-schema-faker generates every contains draw
  Scenario Outline: A contains bound above the array limit is rejected at construction
    Given an array schema of at most 3 integers whose contains sets "<keyword>" to 10000000
    When I create a faker plugin for it
    Then plugin creation fails with resource "array_max_items" at path "$"

    Examples:
      | keyword     |
      | minContains |
      | maxContains |

  Scenario: Small contains bounds are accepted and generate within maxItems
    Given an array schema of at most 5 integers whose contains allows 2 to 3 matches
    When I create a faker plugin for it
    Then the plugin generates an array of at most 5 items
