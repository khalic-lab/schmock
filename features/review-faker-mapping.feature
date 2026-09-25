Feature: Faker Field Mapping Precedence
  As a developer generating mock data from schemas
  I want explicit schema keywords to win over field-name heuristics
  So that generated values honour the contract my schema declares

  Scenario: A default on a name-mapped property is returned verbatim
    Given a schema whose name-mapped properties declare defaults
    When I generate 20 seeded objects from it
    Then every object carries exactly the declared defaults

  Scenario: An explicit schmockTrueProbability wins over the name weighting
    Given a schema where "active" is never true and "deleted" is always true
    When I generate 200 objects from the probability schema
    Then "active" is false and "deleted" is true in every object

  Scenario: Native nullable unions null out at the documented rate
    Given a schema with an integer-or-null "version" and a string-or-null "nick"
    When I generate 200 objects from the nullable schema
    Then fewer than 40 "nick" values are null
    And every non-null "version" is an integer

  Scenario: Date mappings emit the same ISO timestamps in every time zone
    Given a schema with timestamp, birthday, startDate and dueDate strings
    When I generate it with seed 7 under "UTC" and under "Asia/Tokyo"
    Then both runs are identical
    And every date field is an ISO-8601 UTC date-time

  Scenario: Boolean weighting and nullable rolls apply inside allOf
    Given an array schema whose items are an allOf over a base with "isDeleted" and a nullable "nick"
    When I generate 400 items from the allOf schema
    Then "isDeleted" is true in fewer than 20 percent of the items
    And at least one "nick" is null

  Scenario: A dotted override through an array index edits that item only
    Given a schema with an "addresses" array of two city objects
    When I generate it with the override "addresses.0.city" set to "Paris"
    Then "addresses" is still an array of two items
    And the first address city is "Paris"

  Scenario Outline: Short keywords do not match inside unrelated words
    Given a "<type>" property named "<field>"
    When the name matcher looks up a mapping for it
    Then it is not mapped to "<method>"

    Examples:
      | field         | type   | method             |
      | latency       | number | location.latitude  |
      | population    | number | location.latitude  |
      | longestStreak | number | location.longitude |
      | phoneType     | string | phone.number       |
      | cityCode      | string | location.city      |

  Scenario: Primitive array items inherit the singular property name
    Given a schema with an "emails" array of strings
    When I generate an object from the emails schema
    Then every "emails" entry looks like an email address
