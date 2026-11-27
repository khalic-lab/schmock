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

  # json-schema-faker builds and throws away 50 full matches before it cuts a 51st to maxLength
  Scenario: A pattern far longer than its maxLength is charged for every match json-schema-faker builds
    Given an object holding 300 strings whose pattern needs 60000 characters but whose maxLength is 10
    When I create a faker plugin for it
    Then plugin creation fails with resource "generated_chars"

  Scenario: A pattern a little longer than its maxLength still generates
    Given a string schema whose pattern needs 64 hex digits but whose maxLength is 32
    When I create a faker plugin for it
    Then the plugin generates 32 hex digits

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

  # Review 2026-10-23 faker-18: json-schema-faker follows no anchor, $dynamicRef or relative $id
  Scenario Outline: A reference json-schema-faker cannot follow itself generates its target
    Given an object whose property "n" reaches a uuid definition through "<reference>"
    When I create a faker plugin for it
    Then the plugin generates a uuid for "n"

    Examples:
      | reference              |
      | anchor-ref             |
      | dynamic-anchor-ref     |
      | dynamic-ref            |
      | plain-name-id          |
      | embedded-id            |
      | uri-against-root-id    |
      | anchor-ref-to-faker    |
      | registered-id-to-faker |

  Scenario: A JSON Pointer to the same definition still generates
    Given an object whose property "n" reaches a uuid definition through "pointer"
    When I create a faker plugin for it
    Then the plugin generates a uuid for "n"

  Scenario: A $dynamicRef that resolves to nothing is rejected at construction
    Given an object whose property "n" reaches a uuid definition through "unanchored-dynamic-ref"
    When I create a faker plugin for it
    Then plugin creation fails with a schema validation error at "$.properties.n.$dynamicRef"

  # Review 2026-10-23 faker-17: count sizes a root array behind $ref, allOf or a null union
  Scenario Outline: A count above the array limit through a wrapping root is rejected at construction
    Given a root that reaches an integer array through "<wrapper>"
    When I create a faker plugin for it with count 10001
    Then plugin creation fails with resource "array_size"

    Examples:
      | wrapper    |
      | ref        |
      | allof      |
      | anyof-null |

  # The generation budget charges count against that array too: 10000 items
  # of 200 integers each is far past the node limit.
  Scenario Outline: A count past the generation budget through a wrapping root is rejected at construction
    Given a root that reaches an array of 200-integer arrays through "<wrapper>"
    When I create a faker plugin for it with count 10000
    Then plugin creation fails with resource "generated_nodes"

    Examples:
      | wrapper    |
      | ref        |
      | allof      |
      | anyof-null |

  # Review 2026-10-23 faker-2: json-schema-faker honours only some not bodies
  Scenario Outline: A not that generation cannot honour is rejected at construction
    Given the not schema "<case>"
    When I create a faker plugin for it
    Then plugin creation fails with a schema validation error at "<path>"

    Examples:
      | case                      | path                  |
      | not-pattern               | $.not                 |
      | not-beside-all-of         | $.not                 |
      | not-required-all-required | $.not                 |
      | not-type-own-type         | $.not                 |
      | not-beside-faker          | $.properties.name.not |
      | not-in-all-of-entry       | $.allOf[0].not        |
      | not-in-any-of-branch      | $.anyOf[0].not        |
      | not-in-then               | $.then.not            |

  Scenario Outline: A not that generation honours is accepted at construction
    Given the not schema "<case>"
    When I create a faker plugin for it
    Then plugin creation succeeds

    Examples:
      | case                     |
      | not-const                |
      | not-type-in-union        |
      | not-required-optional    |
      | not-ruled-out-by-bounds  |
      | not-forbidden-property   |
      | not-beside-pointer-ref   |
      | not-in-null-union-branch |
