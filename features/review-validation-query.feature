Feature: Validation and query plugin review fixes
  As a developer piping @schmock/validation and @schmock/query
  I want response validation, header and query validation, and pagination to respect HTTP semantics
  So that error responses, header names and query strings behave the way a client expects

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

  # ── Query plugin on error responses (finding 40) ─────────────────────────

  Scenario: A route's 4xx error array is not paginated
    Given a paginated route that returns a 400 tuple with two error items
    When I request the paginated error route
    Then the paginated response status should be 400
    And the paginated response body should be the two unwrapped error items

  Scenario: A guard's 4xx rejection array is not paginated
    Given a guard that rejects with a 422 tuple of two error items before a paginating query plugin
    When I request the paginated error route
    Then the paginated response status should be 422
    And the paginated response body should be the two unwrapped error items

  # ── Query option validation and order case (finding 90) ──────────────────

  Scenario: A default sort field outside the allowed list fails during plugin creation
    When I create a query plugin whose default sort field "nme" is not in the allowed list
    Then plugin creation should fail with code "QUERY_CONFIG_INVALID"

  Scenario: An unknown default sort order fails during plugin creation
    When I create a query plugin with default sort order "DESC"
    Then plugin creation should fail with code "QUERY_CONFIG_INVALID"

  Scenario: The order query value is matched case-insensitively
    Given a sortable route with items "a" and "b"
    When I request the sortable route with order "DESC"
    Then the sorted names should be "b" then "a"
