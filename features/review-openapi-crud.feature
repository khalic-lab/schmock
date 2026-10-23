Feature: OpenAPI CRUD, Prefer and callback review fixes

  As a developer mocking an API from its OpenAPI spec
  I want CRUD routes, Prefer directives and callbacks to follow the declared contract
  So that the mock answers, stores and notifies what the real API would

  # ── Prefer directives ──────────────────────────────────────────────────────

  Scenario: A Prefer code outside the HTTP status range falls through to the normal response
    Given a status mock whose operation declares a 200 and a default response
    When I get the status with Prefer header "code=999"
    Then the status response is 200 with the declared success body

  # ── Item envelopes and delete confirmations ────────────────────────────────

  # Design Decision: the stored row stays bare; only the response is shaped.
  # - Read, update and delete wrap the row in the envelope their own response
  #   declares, the way create already did.
  # - A DELETE declaring a confirmation object the row does not satisfy gets
  #   that object, generated, with the fields it shares with the row copied in.

  Scenario: Read, update and delete answer in the item envelope the spec declares
    Given a validating pets mock whose item operations declare a "data" envelope
    And a pet named "rex" has been created
    When I read, patch to "max" and delete pet 1
    Then each item response is the pet wrapped under "data"
    And the pets list is empty afterwards

  Scenario: A delete that declares a confirmation object answers it around the deleted row
    Given a validating widgets mock whose DELETE declares an id, object and deleted confirmation
    And a widget named "x" has been created
    When I delete widget 1
    Then the delete response is 200 with id "1", object "widget" and deleted true

  # ── Request fields a create or update stores ──────────────────────────────

  Scenario: An update drops a field its closed contract does not declare
    Given a validating pets mock whose pet contract sets additionalProperties false
    And a pet named "rex" has been created
    When I patch pet 1 with name "max" and an undeclared field
    Then the patch response is 200 with only the declared pet fields
    And reading pet 1 answers 200 with only the declared pet fields

  # ── Composition-only create contracts ──────────────────────────────────────

  Scenario: A create whose contract is a oneOf of objects answers a generated branch
    Given a validating sources mock whose create response is a oneOf of bank account and card
    When I create a source with no body
    Then the create response is 201 with id 1 and a bank account or card object
