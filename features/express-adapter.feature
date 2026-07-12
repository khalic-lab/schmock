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
    And the fallback middleware should not have handled the request

  Scenario: Unmatched route reaches Express fallback middleware
    Given I create an Express middleware with a GET /users route for passthrough testing
    When a request is made to "GET /posts"
    Then the Express fallback should return status 418

  Scenario: Unmatched HTTP method reaches Express fallback middleware
    Given I create an Express middleware with only a GET /users route
    When a request is made to "POST /users"
    Then the Express fallback should return status 418

  Scenario: Error status codes are sent as responses not passthrough
    Given I create an Express middleware with a route returning status 500
    When a request is made to "GET /error"
    Then the Express response should have status 500
    And the fallback middleware should not have handled the request

  Scenario: Generator errors return 500 response
    Given I create an Express middleware with a route that throws an error
    When a request is made to "GET /fail"
    Then the Express response should have status 500
    And the fallback middleware should not have handled the request

  Scenario: Response headers are forwarded to Express
    Given I create an Express middleware with a route returning custom headers
    When a request is made to "GET /custom"
    Then the Express response should have status 200
    And the Express response should have header "x-custom" with value "value"

  Scenario Outline: Dynamic and tuple binary responses remain bytes across the Express boundary
    Given I create an Express middleware with a route returning a "<form>" binary value
    When a request is made to "GET /binary"
    Then the Express response should have status "<status>"
    And the Express response should have header "content-type" with value "application/octet-stream"
    And the Express response bytes should be 1, 2, 3

    Examples:
      | form    | status |
      | dynamic | 200    |
      | tuple   | 206    |

  Scenario: errorFormatter fires for non-SchmockError generator errors
    Given I create an Express middleware with errorFormatter and a generator that throws a plain Error
    When a request is made to "GET /boom"
    Then the Express response should have status 500
    And the Express response body should be the formatter output

  Scenario: Custom header and query transforms cross the Express boundary
    Given I create an Express middleware with custom header and query transforms
    When a request is made to "GET /inspect?raw=query" with header "x-raw" set to "value"
    Then the Express response body should be:
      """
      { "header": "header:value", "query": "QUERY" }
      """

  Scenario: beforeRequest can rewrite the request before route matching
    Given I create an Express middleware whose beforeRequest rewrites the request
    When a request is made to "GET /original" with header "x-source" set to "client"
    Then the Express response should have status 201
    And the Express response body should be:
      """
      { "method": "POST", "header": "client", "body": "hook-body", "query": "hook-query" }
      """

  Scenario: beforeResponse can replace the outgoing response
    Given I create an Express middleware whose beforeResponse replaces the response
    When a request is made to "GET /source"
    Then the Express response should have status 202
    And the Express response body should be:
      """
      { "value": "modified" }
      """
    And the Express response should have header "x-before-response" with value "yes"

  Scenario: passErrorsToNext sends adapter failures to Express error middleware
    Given I create an Express middleware whose beforeRequest fails with passErrorsToNext enabled
    When a request is made to "GET /failure"
    Then the Express error middleware should return status 598
    And the Express response body should be:
      """
      { "source": "express-error-handler", "message": "request hook exploded" }
      """

  Scenario: Disabling passErrorsToNext returns the adapter error response
    Given I create an Express middleware whose beforeRequest fails with passErrorsToNext disabled
    When a request is made to "GET /failure"
    Then the Express response should have status 500
    And the Express response body should be:
      """
      { "error": "request hook exploded", "code": "INTERNAL_ERROR" }
      """
    And the Express error middleware should not have handled the request
