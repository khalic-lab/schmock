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
