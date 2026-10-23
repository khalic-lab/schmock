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
