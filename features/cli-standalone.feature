Feature: CLI Standalone Server
  As a developer
  I want to start a mock server from a spec file via CLI
  So that I can quickly prototype against an API

  Scenario: Start server from a spec file
    Given I have a petstore spec file
    When I create a CLI server from the spec
    Then the CLI server should be running
    When I fetch "GET /pets" from the CLI server
    Then the CLI response status should be 200
    And the CLI response body should be an array
    When I stop the CLI server

  Scenario: Serve with seed data
    Given I have a petstore spec file
    And I have a seed data file with pets
    When I create a CLI server with seed data
    And I fetch "GET /pets" from the CLI server
    Then the CLI response status should be 200
    And the CLI response body should contain the seeded pet
    When I stop the CLI server

  Scenario: Custom port
    Given I have a petstore spec file
    And I reserve an available CLI port
    When I create a CLI server on the reserved port
    Then the CLI server should be running on the reserved port
    When I stop the CLI server

  Scenario: CORS headers on responses
    Given I have a petstore spec file
    When I create a CLI server with CORS enabled
    And I fetch "GET /pets" from the CLI server
    Then the CLI response should have CORS headers
    When I stop the CLI server

  Scenario: CORS preflight OPTIONS request
    Given I have a petstore spec file
    When I create a CLI server with CORS enabled
    And I send an OPTIONS preflight to the CLI server
    Then the CLI response status should be 204
    And the CLI response should have CORS headers
    When I stop the CLI server

  Scenario: Missing spec shows usage error
    When I run the CLI without a spec
    Then the CLI process exit code should be 1
    And the CLI error output should contain "Error: --spec is required"

  Scenario: Invalid spec shows error
    Given I have an invalid spec file
    When I create a CLI server from the invalid spec
    Then the CLI error should contain "not a valid Openapi API definition"

  Scenario: Reject unsupported HTTP methods
    Given I have a running CLI petstore server
    When I send a raw CLI request with method "PROPFIND" target "/pets" and host "localhost"
    Then the raw CLI response status should be 405
    And the raw CLI response should allow supported methods
    When I stop the CLI server

  Scenario: Reject a malformed request target
    Given I have a running CLI petstore server
    When I send a raw CLI request with method "GET" target "/pets" and host ":"
    Then the raw CLI response status should be 400
    When I stop the CLI server

  Scenario: Reject an oversized declared request body
    Given I have a running CLI petstore server
    When I send a raw CLI request declaring an oversized body
    Then the raw CLI response status should be 413
    And the raw CLI response should close the connection
    And the CLI server should accept a valid request afterward
    When I stop the CLI server

  Scenario: Reject an oversized chunked request body
    Given I have a running CLI petstore server
    When I send a raw CLI request with an oversized chunked body
    Then the raw CLI response status should be 413
    And the raw CLI response body should contain code "PAYLOAD_TOO_LARGE"

  Scenario: Reject malformed JSON before OpenAPI handling
    Given I have a running CLI petstore server
    When I send a raw CLI request with malformed JSON
    Then the raw CLI response status should be 400
    And the raw CLI response body should contain code "MALFORMED_JSON"
