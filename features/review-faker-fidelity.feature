Feature: Faker output honours every keyword of its schema
  As a developer mocking an API with Schmock
  I want generated data to satisfy composition, conditionals and value
  constraints rather than a name-based guess,
  so that validated mocks never fail on their own output

  # Review 2026-10-23 faker-1: composition is generated, not pre-empted by faker
  Scenario Outline: A composed node is generated from its composition
    Given the fidelity schema "<case>"
    When I generate it with 40 different seeds
    Then every generated value fits "<case>"

    Examples:
      | case                         |
      | root-string-one-of-const     |
      | defs-status-through-ref      |
      | array-items-any-of-const     |
      | additional-properties-all-of |
      | property-if-then-pattern     |
      | boolean-not-const-true       |

  # Review 2026-10-23 faker-5: a field name never overrides an untyped node's keywords
  Scenario Outline: An untyped node keeps the shape and bounds its keywords declare
    Given the fidelity schema "<case>"
    When I generate it with 40 different seeds
    Then every generated value fits "<case>"

    Examples:
      | case                    |
      | untyped-name-max-length |
      | untyped-address-object  |
      | untyped-emails-array    |
      | untyped-price-bounds    |

  # Review 2026-10-23 faker-6: json-schema-faker infers properties from unknown keys
  Scenario Outline: An object without properties never echoes schema keywords into the body
    Given the fidelity schema "<case>"
    When I generate it with 40 different seeds
    Then every generated value fits "<case>"

    Examples:
      | case                       |
      | map-with-definitions       |
      | closed-object-with-example |
      | map-with-dependencies      |
