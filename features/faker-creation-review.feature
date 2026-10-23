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

  # Review 2026-10-23 faker-12: a pattern or faker length floor is as certain as minLength
  Scenario Outline: Strings whose certain lengths add up past the character budget are rejected at construction
    Given an object holding 300 strings that each get 60000 characters from "<source>"
    When I create a faker plugin for it
    Then plugin creation fails with resource "generated_chars"

    Examples:
      | source       |
      | minLength    |
      | pattern      |
      | string.alpha |

  Scenario: A pattern that maxLength truncates is charged only up to maxLength
    Given an object holding 300 strings whose pattern needs 60000 characters but whose maxLength is 10
    When I create a faker plugin for it
    Then plugin creation succeeds

  # Review 2026-10-23 faker-13: allocation limits are keyed by module.method
  Scenario Outline: A faker method reached through the faker back-reference is rejected at construction
    Given a string schema whose faker is "<faker>"
    When I create a faker plugin for it
    Then plugin creation fails with a schema validation error at "$.faker"

    Examples:
      | faker                                                         |
      | person.faker.string.alpha                                     |
      | {"person.faker.string.alpha": [{"length": 5000000}]}          |
      | {"helpers.fake": ["{{person.faker.string.alpha(5000000)}}"]}  |

  Scenario: A helpers.fake template of module.method placeholders still generates
    Given a string schema whose helpers.fake template calls string.alpha with 5 and then person.firstName
    When I create a faker plugin for it
    Then the plugin generates 5 letters, a dash and a name
