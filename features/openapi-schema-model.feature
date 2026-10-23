Feature: OpenAPI schema model fixes

  As a developer mocking an API from its OpenAPI spec
  I want shared components and CRUD paths to keep the contract they declare
  So that requests, generated bodies and stored rows behave like the real API

  # Design Decision: the normalizer never edits the dereferenced spec in place
  # - Dereferencing makes every use of a component one shared object
  # - A $ref with siblings is a fresh object that still shares its target's
  #   properties and required lists
  # - So each use is normalized onto its own copy, and readOnly / writeOnly
  #   flags are read from the shared object rather than deleted from it

  # ── Shared components ─────────────────────────────────────────────────────

  Scenario: A described copy of a component drops its readOnly id from the request contract
    Given a request-validating mock whose review body references User plainly and with a description
    When I post a review whose author and reviewer carry only a name
    Then the review response has status 201

  Scenario: Every property that references a shared readOnly component ignores client values
    Given a pets mock whose createdAt and updatedAt reference one readOnly Timestamp component
    When I create a pet sending createdAt and updatedAt "1999-01-01T00:00:00Z"
    Then the created pet has status 201
    And neither timestamp of the created pet is "1999-01-01T00:00:00Z"

  Scenario: A readOnly name that another allOf branch requires is not required in requests
    Given a request-validating accounts mock whose second allOf branch requires the readOnly id
    When I create an account with only a name and a password
    Then the account response has status 201

  Scenario: A writeOnly name that another allOf branch requires is never generated
    Given a response-validating profile mock whose second allOf branch requires the writeOnly password
    When I read the profile
    Then the profile response has status 200
    And the profile has no "password" key

  # ── Recursive schemas ─────────────────────────────────────────────────────

  # Design Decision: a cycle ends where a generated instance can stop
  # - An optional property that closes the cycle is left out
  # - An array of the enclosing schema defaults to empty
  # - Anywhere else the cut is an open schema that generates null
  # - Validation stays as permissive as the old empty-schema cut

  Scenario: A self-referential schema generates instead of failing
    Given a response-validating mock whose tree node lists children of its own type and has an optional parent
    When I read the tree
    Then the tree response has status 200
    And the tree has no "parent" key and an empty "children" list

  Scenario: The Scalar Galaxy planets seed from a count despite their recursion
    Given the Scalar Galaxy spec seeded with 2 generated planets
    When I list the planets
    Then the planets response has status 200
    And the planet list holds 2 planets
