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
