Feature: Query plugin review fixes
  As a developer piping @schmock/query
  I want pagination and sorting to respect HTTP semantics and reject bad options
  So that error responses stay intact and misconfigured sorting fails early

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

  # ── Sorting defaults (review 2026-10-23) ─────────────────────────────────

  Scenario Outline: A sort or order value the plugin cannot use falls back to the configured defaults
    Given a route sorted by "n" descending by default with items "b", "a" and "c"
    When I request the default-sorted route with sort "<sort>" and order "<order>"
    Then the default-sorted names should be "c", "b" and "a"

    Examples:
      | sort   | order      |
      | n      | sideways   |
      | n      | descending |
      | secret | desc       |
      | secret | sideways   |

  Scenario: An empty sort and order fall back to the configured defaults
    Given a route sorted by "n" descending by default with items "b", "a" and "c"
    When I request the default-sorted route with sort "" and order ""
    Then the default-sorted names should be "c", "b" and "a"
