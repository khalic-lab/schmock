Feature: Standalone Server
  As a developer
  I want to start Schmock as a standalone HTTP server
  So that I can test against it with real HTTP requests

  Scenario: Start and stop a simple server
    Given I create a mock with a GET /hello route
    When I start the server on a random port
    Then the server should be running
    When I fetch "GET /hello" from the server
    Then the HTTP response status should be 200
    And the HTTP response body should have "message" equal to "hello"
    When I stop the server
    Then the server should not be running

  Scenario: Handle POST with JSON body
    Given I create a mock echoing POST at "/echo"
    When I start the server on a random port
    And I fetch "POST /echo" with JSON body:
      """
      { "name": "Alice", "age": 30 }
      """
    Then the response status from POST should be 200
    And the response body from POST should have "name" equal to "Alice"
    When I stop the server

  Scenario: Return 404 for unregistered routes
    Given I create a mock with a GET /hello route
    When I start the server on a random port
    And I fetch "GET /unknown" from the server
    Then the HTTP response status should be 404
    When I stop the server

  Scenario: Query parameters are forwarded
    Given I create a mock reflecting query params at "GET /search"
    When I start the server on a random port
    And I fetch "GET /search?q=foo&limit=10" from the server
    Then the HTTP response status should be 200
    And the HTTP response body should have "q" equal to "foo"
    And the query param "limit" should equal "10"
    When I stop the server

  Scenario: Double listen throws an error
    Given I create a mock with a GET /hello route
    When I start the server on a random port
    Then starting the server again should throw

  Scenario: Close is idempotent
    Given I create a mock with a GET /hello route
    When I start the server on a random port
    And I stop the server
    Then stopping the server again should not throw

  Scenario: Reset stops the server
    Given I create a mock with a GET /hello route
    When I start the server on a random port
    And I reset the mock
    Then the server should not be running
