Feature: Core response and error-path review fixes
  As a developer using Schmock
  I want every response, error and debug log to keep its contract at the edges
  So that a client never receives invalid JSON and a request never fails for a diagnostic reason

  # ── Response bodies ──────────────────────────────────────────────────────

  Scenario: A route returning a Date sends a JSON string literal
    Given a mock whose route "GET /time" returns the Date 1970-01-01T00:00:00.000Z
    When I fetch "/time" through intercept
    Then the response content type is "application/json"
    And the response body parses as the JSON string "1970-01-01T00:00:00.000Z"

  Scenario: A text/plain route rejects an object body a JSON route would reject
    Given a mock whose text/plain route "GET /note" returns an object with an undefined field
    When I request "GET /note"
    Then I receive status 500 with code "INVALID_RESPONSE"

  # ── Error paths ──────────────────────────────────────────────────────────

  Scenario: A route throwing an Error without a string message still answers a JSON 500
    Given a mock whose route "GET /broken" throws an Error whose message is undefined
    And a request:end listener
    When I request "GET /broken"
    Then I receive status 500 with code "INTERNAL_ERROR"
    And the response error is the string "Unknown error"
    And exactly one request:end with status 500 was emitted

  Scenario: An error formatter can read a non-Error value a route threw
    Given a mock whose route "GET /quota" throws a plain object with reason "quota exceeded"
    And an intercept with an error formatter that returns the error's cause
    When I fetch "/quota" through that intercept
    Then the fetched status is 500
    And the fetched body is the thrown object with reason "quota exceeded"

  Scenario: Static JSON data every request would reject fails when the route is defined
    Given an empty mock
    When I define "GET /profile" with static data holding a Map
    Then the definition throws a RouteDefinitionError mentioning "unsupported object"
    And the mock has no routes
