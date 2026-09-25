Feature: OpenAPI $ref resolution review fixes
  As a developer loading an OpenAPI spec I do not fully trust
  I want $ref resolution to stay inside the limits the ref policy promises
  So that a spec cannot reach internal hosts or local files, and resolves the same way everywhere

  Scenario: An http $ref whose hostname resolves to a loopback address is refused
    Given an internal service listening on the loopback interface
    And DNS resolves "internal.example.test" to the loopback interface
    When I parse a spec whose schema is an http reference to "internal.example.test" with any public host allowed
    Then parsing fails naming a loopback, link-local or private address
    And the internal service received no request

  Scenario: A remote document cannot pull in a local file
    Given a local file holding a secret
    And an allow-listed remote document that references the secret by file URL
    When I parse a local spec that references the remote document
    Then parsing fails with code "OPENAPI_EXTERNAL_REF_BLOCKED"
    And the error does not contain the secret

  Scenario: A redirect to a file URL is refused
    Given an allow-listed host that redirects to a file URL
    When I read an http reference from that host with one redirect allowed
    Then the read fails because the redirect target is not http(s)
    And only the original URL was requested

  Scenario: An oversized streamed $ref body stops at the byte limit
    Given an allow-listed host that streams a large body without a Content-Length
    When I read an http reference from that host with a 4096 byte limit
    Then the read fails naming the 4096 byte limit
    And the host was asked for little more than 4096 bytes

  Scenario: A timed-out http $ref names the timeout
    Given an allow-listed host that never answers
    When I parse a spec referencing that host with a 50 ms timeout
    Then parsing fails with a message naming a 50ms timeout

  Scenario: A spec file loads when a DOM window global is present
    Given a DOM-like window global pointing at "http://localhost:3000/"
    When I parse the external fixture spec by path with external references enabled
    Then the referenced schema is inlined
    And no network request was attempted

  Scenario: OpenAPI 3.1 $ref siblings add to the target schema
    Given an OpenAPI 3.1 spec whose request body extends a base schema with $ref siblings
    When I create an openapi plugin from the spec
    Then a POST missing the base schema's required fields is rejected with 400
    And a POST carrying every required field is accepted

  Scenario: A $ref sibling wins regardless of document order
    Given a spec where a bare reference to "Name" comes before a reference to "Name" with maxLength 3
    When I parse the spec
    Then the property with the sibling has maxLength 3

  Scenario: A ring of $refs fails with a coded error
    Given a spec whose schemas "A" and "B" only reference each other
    When I parse the spec expecting a failure
    Then parsing fails with code "OPENAPI_INVALID_REF"

  Scenario: $ref-shaped content inside an example is kept as data
    Given a spec whose response example is a $ref to another host
    When I parse the spec
    Then the example is not treated as a reference

  Scenario: An OpenAPI 3.2 spec loads the same with or without a $ref
    Given an OpenAPI "3.2.0" spec whose response schema is an internal reference
    When I parse the spec
    Then the response schema is the referenced component
