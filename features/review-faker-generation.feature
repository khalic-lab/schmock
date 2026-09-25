Feature: Faker generation review fixes
  As a developer mocking an API with Schmock
  I want generated data to satisfy the schema it was generated from,
  with resource limits that reject only what would really be too large,
  so that validated mocks never fail on their own output

  # Finding 17: format byte
  Scenario: A byte-format string is valid padded base64
    Given a response schema with byte-format fields "payload" and "thumbnail"
    When I generate it with 40 different seeds
    Then every "payload" and "thumbnail" value is valid padded base64

  # Finding 19: lone numeric bounds past json-schema-faker's default range
  Scenario Outline: A lone numeric bound outside json-schema-faker's default range is honoured
    Given an integer schema with only "<keyword>" set to "<bound>"
    When I generate it with 40 different seeds
    Then every generated number satisfies "<keyword>" "<bound>"

    Examples:
      | keyword          | bound      |
      | minimum          | 1900       |
      | minimum          | 1600000000 |
      | exclusiveMinimum | 5000       |
      | maximum          | -5000      |
      | exclusiveMaximum | -5000      |

  # Finding 24: memory heuristics replaced by the node budget
  Scenario: An explicit count above 100 over a three-level item schema is accepted
    Given a faker plugin over a list of users with a nested address and geo point and count 101
    When the plugin generates a response
    Then the response is a list of 101 users

  Scenario: A 100-item array nested three levels deep is accepted
    Given a faker plugin over an object whose third level holds a 100-item integer array
    When the plugin generates a response
    Then the nested array holds 100 integers

  # Finding 71: patternProperties
  Scenario: Pattern properties fill minProperties with keys that match the pattern
    Given an object schema with property "a", pattern "^x_" of integers, no additional properties and minProperties 2
    When I generate it with 20 different seeds
    Then every generated object has at least 2 keys
    And every key other than "a" matches "^x_" and holds an integer

  Scenario: A pattern-keyed map is not generated empty
    Given an object schema whose only keys match "^[a-z]{2}$" and hold strings
    When I generate it with 20 different seeds
    Then every generated object has at least 1 key
    And every key matches "^[a-z]{2}$" and holds a string

  # Finding 77: aggregate output budget
  Scenario: A schema whose strings add up past the character budget is rejected at construction
    Given an array schema of 300 strings that each have minLength 65536
    When I create a faker plugin for it
    Then plugin creation fails with resource "generated_chars"

  # Finding 78: allocation policies
  Scenario Outline: A faker allocation argument that cannot fit in one string is rejected at construction
    Given a string schema whose faker is "<faker>"
    When I create a faker plugin for it
    Then plugin creation fails with resource "string_length"

    Examples:
      | faker                                                  |
      | {"lorem.paragraphs": [65536]}                          |
      | {"lorem.words": [65536]}                               |
      | {"helpers.fake": ["{{lorem.paragraphs(20000)}}"]}      |
      | {"helpers.fromRegExp": ["a{2000000}"]}                 |
      | {"helpers.mustache": ["{{a}}{{a}}{{a}}", {"a": "__LONG__"}]} |

  Scenario: A pattern whose quantifier cannot fit in one string is rejected at construction
    Given a string schema with pattern "^(a{300}){300}$"
    When I create a faker plugin for it
    Then plugin creation fails with resource "string_length"

  # Finding 79: non-generating subschemas
  Scenario Outline: Limits inside a subschema that never generates do not reject the schema
    Given the non-generating schema "<case>"
    When I create a faker plugin for it
    Then plugin creation succeeds
    And the plugin generates a response that fits "<case>"

    Examples:
      | case               |
      | not-min-length     |
      | if-min-items       |
      | unreferenced-defs  |

  Scenario: Limits inside a referenced definition still apply
    Given the non-generating schema "referenced-defs"
    When I create a faker plugin for it
    Then plugin creation fails with resource "array_max_items"

  # Review 2026-09-25: json-schema-faker merges an if into its then
  Scenario Outline: Limits inside an if beside a then reject the schema at construction
    Given the conditional schema "<case>"
    When I create a faker plugin for it
    Then plugin creation fails with resource "<resource>" at path "$.properties.a.if"

    Examples:
      | case               | resource        |
      | if-uncapped-items  | array_max_items |
      | if-uncapped-length | string_length   |

  # Review 2026-09-25: the node budget counts every item json-schema-faker materializes
  Scenario Outline: Nested arrays reached through an item keyword count against the node budget
    Given a 3000 by 3000 integer array reached only through "<keyword>"
    When I create a faker plugin for it
    Then plugin creation fails with resource "generated_nodes"

    Examples:
      | keyword          |
      | prefixItems      |
      | contains         |
      | containsAll      |
      | dependentSchemas |

  # Finding 80: resource limit errors carry a path
  Scenario: A nested resource-limit breach names the offending schema path
    Given an object schema whose property "a.b" declares minItems 20000
    When I create a faker plugin for it
    Then plugin creation fails with resource "array_max_items" at path "$.properties.a.properties.b"

  Scenario: A nested faker argument breach names the faker path
    Given an object schema whose property "a" uses faker "string.alpha" with length 100000
    When I create a faker plugin for it
    Then plugin creation fails with resource "string_length" at path "$.properties.a.faker"

  # Finding 81: union types
  Scenario: A typo inside a union type is rejected at construction
    Given an object schema whose property "a" has the union type "strng" or "null"
    When I create a faker plugin for it
    Then plugin creation fails with a schema validation error at "$.properties.a"

  Scenario: A nullable array without items is rejected like a plain array without items
    Given an object schema whose property "tags" has the union type "array" or "null" and no items
    When I create a faker plugin for it
    Then plugin creation fails with a schema validation error at "$.properties.tags.items"

  # Finding 82: chance keyword
  Scenario: The chance keyword is rejected at construction with its path
    Given an object schema whose property "bio" is a string with chance "paragraph"
    When I create a faker plugin for it
    Then plugin creation fails with a schema validation error at "$.properties.bio.chance"

  # Finding 83: inherited members are not faker methods
  Scenario Outline: An Object.prototype member is not accepted as a faker method
    Given an object schema whose property "a" uses faker method "<method>"
    When I create a faker plugin for it
    Then plugin creation fails with a schema validation error at "$.properties.a.faker"

    Examples:
      | method                  |
      | person.toString         |
      | person.constructor      |
      | helpers.hasOwnProperty  |
      | person.valueOf          |
