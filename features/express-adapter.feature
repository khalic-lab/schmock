Feature: Express Adapter
  As a developer using Schmock with Express
  I want the Express middleware to correctly handle matched and unmatched routes
  So that Schmock integrates seamlessly into my Express application

  Scenario: Matched route returns Schmock response
    Given I create an Express middleware with a GET /users route returning users
    When a request is made to "GET /users"
    Then the Express response should have status 200
    And the Express response body should be:
      """
      [{ "id": 1, "name": "John" }]
      """
    And next should not have been called

  Scenario: Unmatched route calls next for passthrough
    Given I create an Express middleware with a GET /users route for passthrough testing
    When a request is made to "GET /posts"
    Then next should have been called without error

  Scenario: Unmatched HTTP method calls next for passthrough
    Given I create an Express middleware with only a GET /users route
    When a request is made to "POST /users"
    Then next should have been called without error

  Scenario: Error status codes are sent as responses not passthrough
    Given I create an Express middleware with a route returning status 500
    When a request is made to "GET /error"
    Then the Express response should have status 500
    And next should not have been called

  Scenario: Generator errors return 500 response
    Given I create an Express middleware with a route that throws an error
    When a request is made to "GET /fail"
    Then the Express response should have status 500
    And next should not have been called

  Scenario: Response headers are forwarded to Express
    Given I create an Express middleware with a route returning custom headers
    When a request is made to "GET /custom"
    Then the Express response should have status 200
    And the Express response should have header "x-custom" with value "value"
