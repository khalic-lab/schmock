Feature: OpenAPI request bodies as the transports deliver them
  As a developer validating requests against an OpenAPI spec
  I want each request body checked in the shape a real client sends it
  So that a valid upload or form post is accepted on every transport

  # Design Decision: validate what the transport decoded, read the way the spec means it
  # - Core decodes a body by media type: parsed JSON, a record of strings for
  #   urlencoded forms, FormData for multipart, a string for text/*, and bytes
  #   for anything else. The openapi plugin reads that value through the
  #   operation's schema before it validates it.
  # - Requests go through the fetch interceptor, the path React, Vue and the
  #   DevTools relay use, not only through mock.handle().

  Scenario: A nullable binary upload schema accepts the bytes every transport delivers
    Given a validating upload mock whose octet-stream body is a nullable binary string
    When I post three bytes as "application/octet-stream" through the fetch interceptor
    Then the upload response status is 201

  # ── Form bodies are read through their schema ────────────────────────────

  Scenario: A multipart upload with a text field and a file is accepted
    Given a validating upload mock whose multipart body requires a name and a binary file
    When I post a multipart form with name "Rex" and a file through the fetch interceptor
    Then the upload response status is 201

  Scenario: A multipart field that breaks its schema is rejected when nothing is required
    Given a validating upload mock whose multipart body has an optional integer count
    When I post a multipart form with count "not-a-number" through the fetch interceptor
    Then the upload response status is 400
    And the upload validation error points at "/count"

  Scenario: Typed urlencoded fields are read as the types their schema declares
    Given a validating upload mock whose urlencoded body has integer, boolean and number fields
    When I post the urlencoded form "qty=3&active=true&price=9.5" through the fetch interceptor
    Then the upload response status is 201

  Scenario: An urlencoded integer field must be written in plain decimal notation
    Given a validating upload mock whose urlencoded body has integer, boolean and number fields
    When I post the urlencoded form "qty=1e3" through the fetch interceptor
    Then the upload response status is 400
    And the upload validation error points at "/qty"

  Scenario: Bracketed urlencoded keys nest under the object property they name
    Given a validating upload mock whose urlencoded body declares only a metadata object
    When I post the urlencoded form "metadata[order]=42" through the fetch interceptor
    Then the upload response status is 201

  # ── Repeated names and the encoding map ──────────────────────────────────
  # Core keeps the last value of a repeated urlencoded name in the body record
  # and passes the whole form beside it; Express's parser builds the array
  # itself. Either way a property declared as an array gets every value, and
  # a property whose encoding does not explode is split on its delimiter.

  Scenario: A repeated urlencoded name fills an array property through the fetch interceptor
    Given a validating notes mock whose urlencoded tags are an array of at least two strings
    When I create a note with the urlencoded form "tags=a&tags=b" through the fetch interceptor
    Then the upload response status is 201
    And the stored note has the tags "a" and "b"

  Scenario: A repeated urlencoded name fills an array property through Express
    Given a validating notes mock whose urlencoded tags are an array of at least two strings
    When I create a note with the urlencoded form "tags=a&tags=b" through Express
    Then the upload response status is 201
    And the stored note has the tags "a" and "b"

  Scenario: A comma-separated value fills an array property whose encoding does not explode
    Given a validating notes mock whose urlencoded tags are encoded as form with explode false
    When I create a note with the urlencoded form "tags=a,b" through the fetch interceptor
    Then the upload response status is 201
    And the stored note has the tags "a" and "b"

  # ── Bodies core does not parse ───────────────────────────────────────────

  Scenario: An XML body is not validated against its object schema
    Given a validating upload mock whose XML body requires a name
    When I post an XML pet named "Rex" through the fetch interceptor
    Then the upload response status is 201
