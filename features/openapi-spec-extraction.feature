Feature: Reading an operation's contract out of a spec
  As a developer mocking an API from an OpenAPI or Swagger 2.0 spec
  I want every part of an operation's contract read the way the spec defines it
  So that the mock answers what the spec declares instead of failing on it

  # Design Decision: read each dialect's own spelling into one JSON Schema model
  # - Swagger 2.0 keeps some schema keywords inline (headers, parameters) and
  #   has a `file` type JSON Schema lacks; both are read into the same schema
  #   an OpenAPI 3 spec would declare.

  Scenario: A Swagger 2.0 file download answers with a binary body
    Given a mock from a Swagger 2.0 spec whose report download is a file
    When I download the report
    Then the download response status is 200
    And the download response content type is "application/pdf"

  Scenario: Swagger 2.0 response headers honour their inline default, bounds and length
    Given a mock from a Swagger 2.0 spec whose item list declares constrained headers
    When I list the items
    Then the rate limit header uses its default "100"
    And the page size header uses its minimum "10"
    And the token header is "xxxxxxxx" at its minimum length

  Scenario: A Content-Type response header with no fixed value is ignored
    Given a mock whose report response declares a Content-Type header of any string
    When I fetch the report
    Then the report response status is 200
    And the report response content type is the negotiated "application/json"

  Scenario: A security scheme the mock cannot simulate is reported, not dropped silently
    Given an OpenAPI 3.1 spec whose operations require a mutualTLS scheme
    When I parse the secured spec
    Then the parse warnings say the "clientCert" scheme of type "mutualTLS" is skipped
