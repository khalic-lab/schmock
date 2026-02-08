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
    When I create a CLI server on port 9876
    Then the CLI server should be running on port 9876
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
    When I create a CLI server without a spec
    Then the CLI should throw a missing spec error

  Scenario: Invalid spec shows error
    Given I have an invalid spec file
    When I create a CLI server from the invalid spec
    Then the CLI should throw a parse error
