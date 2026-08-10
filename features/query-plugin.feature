Feature: Query Plugin
  As an API consumer
  I want pagination, sorting, and filtering on mock endpoints
  So that I can test real-world REST patterns without writing generator code

  Scenario: Basic pagination with default settings
    Given I create a mock with 25 items and pagination plugin
    When I request page 1
    Then I should receive 10 items
    And the pagination total should be 25
    And the pagination totalPages should be 3

  Scenario: Pagination with custom limit
    Given I create a mock with 25 items and pagination plugin
    When I request page 1 with limit 5
    Then I should receive 5 items
    And the pagination totalPages should be 5

  Scenario: Sort items ascending by name
    Given I create a mock with named items and sorting plugin
    When I request with sort "name" order "asc"
    Then the first item name should be "Alice"
    And the last item name should be "Charlie"

  Scenario: Sort items descending by name
    Given I create a mock with named items and sorting plugin
    When I request with sort "name" order "desc"
    Then the first item name should be "Charlie"
    And the last item name should be "Alice"

  Scenario: Filter items by field value
    Given I create a mock with categorized items and filtering plugin
    When I request with filter role "admin"
    Then I should receive 2 filtered items
    And all items should have role "admin"

  Scenario: Combined pagination, sorting, and filtering
    Given I create a mock with 20 users and full query plugin
    When I request page 1 with limit 2 filter role "admin" and sort "name"
    Then I should receive 2 items
    And the items should be sorted by name ascending
    And all items should have role "admin"
    And the pagination total should reflect filtered count

  Scenario Outline: Paginate array response containers without losing metadata
    Given I create a mock returning 5 items in a "<container>" response
    When I request page 2 with limit 2
    Then the response status should be 206
    And response header "x-query-source" should be "<container>"
    And I should receive 2 items
    And the pagination total should be 5

    Examples:
      | container  |
      | tuple      |
      | structured |

  Scenario: Pass array responses through when the plugin has no options
    Given I create a mock with 5 items and the query plugin with no options
    When I request the list
    Then the response status should be 200
    And the response body should be an array of 5 items

  Scenario Outline: Fall back to defaults for malformed pagination values
    Given I create a mock with 25 items and pagination plugin
    When I request with raw "<param>" value "<value>"
    Then the pagination page should be "<page>"
    And the pagination limit should be "<limit>"

    Examples:
      | param | value | page | limit |
      | page  | 3abc  | 1    | 10    |
      | page  | 2.9   | 1    | 10    |
      | page  | +2    | 1    | 10    |
      | limit | 1e2   | 1    | 10    |
      | limit | 3abc  | 1    | 10    |
      | limit | -1    | 1    | 10    |
