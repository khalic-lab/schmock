Feature: Validation plugin review fixes
  As a developer piping @schmock/validation
  I want response validation and header and query-string validation to respect HTTP semantics
  So that error responses, header names and query strings behave the way a client expects

  # The query plugin's review scenarios (findings 40 and 90) live in
  # review-query-plugin.feature, next to the package they exercise.

  # ── Response validation scope (findings 38, 88) ─────────────────────────

  Scenario: A 2xx-scoped response schema lets another plugin's rejection through
    Given a guard that rejects unauthenticated requests with 401 before a 2xx-scoped array response schema
    When I request the guarded list without credentials
    Then the scoped response status should be 401
    And the scoped response body should have error "unauthorized"

  Scenario: A 2xx-scoped response schema leaves a route's error tuple alone
    Given a route that returns a 404 tuple under a 2xx-scoped object response schema
    When I request a user that does not exist
    Then the scoped response status should be 404
    And the scoped response body should have error "not found"

  Scenario: A 2xx-scoped response schema still rejects an invalid success body
    Given a route that returns an invalid success body under a 2xx-scoped object response schema
    When I request the invalid success body
    Then the scoped response status should be 500
    And the scoped response body should have code "RESPONSE_VALIDATION_ERROR"

  Scenario: An explicit status list validates only the listed statuses
    Given a response schema scoped to status 201 on routes answering 200 and 201 with invalid bodies
    When I request both scoped routes
    Then the 200 route should answer 200 unchanged
    And the 201 route should answer 500 with code "RESPONSE_VALIDATION_ERROR"

  Scenario: An invalid response status scope fails during plugin creation
    When I create a validation plugin with response statuses "3xx"
    Then plugin creation should fail with code "VALIDATION_CONFIG_INVALID"

  # ── Header name case (finding 86) ────────────────────────────────────────

  Scenario: A capitalized optional header property still enforces its constraints
    Given a header schema with an optional "X-Api-Key" property of at least 8 characters
    When I send header "X-Api-Key" with value "short"
    Then the header response status should be 400
    And the header response body should have code "HEADER_VALIDATION_ERROR"

  Scenario: A capitalized required header property accepts a matching header
    Given a header schema that requires an "X-Api-Key" property of at least 8 characters
    When I send header "x-api-key" with value "abcdefghij"
    Then the header response status should be 200

  Scenario: Header properties that differ only by case fail during plugin creation
    When I create a header schema with both "X-Api-Key" and "x-api-key" properties
    Then plugin creation should fail with code "VALIDATION_CONFIG_INVALID"

  Scenario: Unreferenced definitions whose names differ only by case do not affect headers
    Given a header schema that references "X-Api-Key" from a definitions bundle whose other models declare "ID" and "id"
    Then the header plugin should have been created
    When I send header "X-API-KEY" with value "short"
    Then the header response status should be 400
    And the header response body should have code "HEADER_VALIDATION_ERROR"

  Scenario: propertyNames sees a declared header in the schema's spelling
    Given a header schema declaring "X-Api-Key" whose property names must be lowercase
    When I send header "x-api-key" with value "abcdefghij"
    Then the header response status should be 400
    And the header response body should reject the property name "X-Api-Key"

  Scenario Outline: patternProperties sees declared headers in the schema's spelling and others lowercased
    Given a header schema declaring "X-Api-Key" with a "^x-" pattern limited to 12 characters
    When I send header "<header>" with value "<value>"
    Then the header response status should be <status>

    Examples:
      | header     | value                     | status |
      | X-Trace-Id | 0123456789abc             | 400    |
      | x-api-key  | 0123456789abcdefghijklmno | 200    |

  # ── Query and header coercion (finding 87) ───────────────────────────────

  Scenario: An integer query schema accepts a numeric query string
    Given a query schema requiring an integer page of at least 1
    When I request the coerced list with query page "2"
    Then the coerced response status should be 200
    And the route should have received page as the string "2"

  Scenario: An integer query schema still rejects a non-numeric query string
    Given a query schema requiring an integer page of at least 1
    When I request the coerced list with query page "two"
    Then the coerced response status should be 400
    And the coerced response body should have code "QUERY_VALIDATION_ERROR"

  Scenario: An integer header schema accepts a numeric header value
    Given a header schema requiring an integer "x-count" header
    When I send header "x-count" with value "3"
    Then the header response status should be 200

  # ── Coerced numbers must be finite plain decimals (cold review) ──────────

  Scenario Outline: A bounded integer query schema rejects a number the route would misread
    Given a query schema requiring an integer limit from 1 through 50
    When I request the bounded list with query limit "<limit>"
    Then the bounded response status should be 400
    And the bounded response body should have code "QUERY_VALIDATION_ERROR"
    And the bounded route should not have run

    Examples:
      | limit     |
      | Infinity  |
      | -Infinity |
      | 1e400     |
      | 0x10      |
      | 1e1       |

  Scenario: A bounded integer query schema accepts a decimal limit within range
    Given a query schema requiring an integer limit from 1 through 50
    When I request the bounded list with query limit "50"
    Then the bounded response status should be 200
    And the bounded route should have received limit as the string "50"

  Scenario Outline: A bounded integer header schema rejects a non-finite value
    Given a header schema requiring an integer "x-limit" header from 1 through 50
    When I send header "x-limit" with value "<limit>"
    Then the header response status should be 400
    And the header response body should have code "HEADER_VALIDATION_ERROR"

    Examples:
      | limit     |
      | Infinity  |
      | -Infinity |
      | 1e400     |
