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

  # Review 2026-10-23 faker-8: one finite bound per side reaches json-schema-faker
  Scenario Outline: Numeric bounds hold beside multipleOf and a second bound on the same side
    Given the fidelity schema "<case>"
    When I generate it with 40 different seeds
    Then every generated value fits "<case>"

    Examples:
      | case                                     |
      | multiple-of-lone-maximum                 |
      | multiple-of-wide-step-lone-maximum       |
      | inclusive-minimum-tighter-than-exclusive |
      | inclusive-maximum-tighter-than-exclusive |

  # Review 2026-10-23 faker-2: not.type, not.required and not.const are generated around
  Scenario Outline: A not keyword rejects the values it names
    Given the fidelity schema "<case>"
    When I generate it with 40 different seeds
    Then every generated value fits "<case>"

    Examples:
      | case                   |
      | not-required-pair      |
      | not-type-in-union      |
      | not-const-empty-string |

  # Review 2026-10-23 faker-4: json-schema-faker keeps the first declaration's faker
  Scenario Outline: A property declared by several merged schemas honours every declaration
    Given the fidelity schema "<case>"
    When I generate it with 40 different seeds
    Then every generated value fits "<case>"

    Examples:
      | case                                 |
      | all-of-max-length-on-mapped-email    |
      | all-of-enum-on-ref-target-email      |
      | then-pattern-on-zip                  |
      | all-of-min-length-on-unmapped-string |

  # Review 2026-10-23 faker-3: json-schema-faker's allOf merge dropped sibling composition
  Scenario Outline: Composition beside allOf is generated with it
    Given the fidelity schema "<case>"
    When I generate it with 40 different seeds
    Then every generated value fits "<case>"

    Examples:
      | case                               |
      | all-of-with-sibling-one-of         |
      | all-of-with-sibling-any-of         |
      | defs-base-with-sibling-one-of-refs |
      | all-of-with-sibling-if-then        |

  # Review 2026-10-23 faker-14: a bounded byte string is generated in whole blocks
  Scenario Outline: A byte string with length bounds is valid padded base64 within them
    Given the fidelity schema "<case>"
    When I generate it with 40 different seeds
    Then every generated value fits "<case>"

    Examples:
      | case                |
      | byte-max-length-10  |
      | byte-min-length-80  |
      | byte-length-5-to-30 |
