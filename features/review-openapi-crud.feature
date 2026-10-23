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

  # ── Singletons served through the list generator ───────────────────────────

  Scenario: A singleton whose item holds an array answers the declared item
    Given a validating dispute mock with GET and POST on one path and a balance_transactions array
    When I create a dispute and then read it
    Then the dispute read is 200 with generated balance transactions, not the created dispute

  # ── Form bodies on CRUD routes ─────────────────────────────────────────────

  Scenario: A multipart create stores its text fields, typed, and not its file
    Given a validating pets mock whose create accepts a multipart name, age and photo
    When I post a multipart pet named "Rex" aged "3" with a photo through the fetch interceptor
    Then the created pet is 201 with name "Rex" and age 3 and no photo
    And reading pet 1 answers the same pet

  # ── onSchema on an enveloped create ────────────────────────────────────────

  Scenario: onSchema receives an enveloped create's whole response contract
    Given a pets mock whose create answers a data and meta envelope, with an onSchema hook that rewrites meta
    When I create a pet named "rex"
    Then the hook saw the create contract with properties "data,meta"
    And the created body carries the rewritten meta and the pet under "data"

  # ── Resource list overrides ────────────────────────────────────────────────

  Scenario: A list override is validated against the shape it serves
    Given a validating users mock whose flat list is overridden with listWrapProperty "data"
    And a user named "A" has been created
    When I list the users
    Then the users list is 200 with the user under "data"

  # ── Status-less schema overrides ───────────────────────────────────────────

  Scenario: A status-less schemas key patches the 201 an upsert-shaped create answers with
    Given an upserts mock whose create declares 200 and 201, with a "POST /upserts" schemas override
    When I create an upsert
    Then the create response is 201 with the overridden body
