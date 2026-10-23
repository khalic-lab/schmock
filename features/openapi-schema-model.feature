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

  # ── Nullable compositions ─────────────────────────────────────────────────

  Scenario: A nullable property that declares a type and an allOf accepts null
    Given a request-validating mock whose pet owner is a nullable object composed with allOf
    When I post a pet whose owner is null
    Then the pet response has status 204

  # ── Examples ──────────────────────────────────────────────────────────────

  Scenario: A 3.1 examples array does not pin the generated value
    Given a 3.1 mock whose trip id is a uuid declaring a malformed example
    When I read the trip id three times
    Then every trip id is a well-formed uuid and none is the example

  # ── CRUD detection ────────────────────────────────────────────────────────

  Scenario: A resource whose paths end in a slash stores what it creates
    Given a pets mock whose collection and item paths end in a slash
    When I create a pet named "Rex" at "/api/pets/"
    Then reading "/api/pets/1/" returns the pet named "Rex"
    And listing "/api/pets/" returns only the pet named "Rex"

  Scenario: A missing row answers with the error schema the spec declares under default
    Given a response-validating pets mock whose operations declare their errors only under "default"
    When I read pet 999
    Then the read response has status 404
    And the error body has a numeric "code" and a string "message"

  Scenario: A polymorphic item schema whose variants declare a string id mints string ids
    Given a response-validating sources mock whose item is an anyOf of two variants with a string id
    When I create a source with last4 "4242"
    Then the created source has status 201 and a string id
    And reading the source by that id returns last4 "4242"

  # ── Parse warnings ────────────────────────────────────────────────────────

  Scenario: A TRACE operation is reported in debug mode instead of dropped silently
    Given a spec whose path "/x" declares GET and TRACE
    When I load it in debug mode
    Then a warning says the TRACE operation on "/x" is not supported
    And GET "/x" still answers 200

  # ── Discriminators ────────────────────────────────────────────────────────

  Scenario: A discriminator beside anyOf generates each branch with its own mapping key
    Given a mock whose pet is a discriminated anyOf of Cat and Dog mapped as "cat" and "dog"
    When I read the pet with 12 different faker seeds
    Then every pet that meows has petType "cat" and every pet that barks has petType "dog"
