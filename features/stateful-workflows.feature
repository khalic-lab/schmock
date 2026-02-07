Feature: Stateful Workflows E2E
  As a developer creating stateful applications
  I want to maintain consistent state across requests
  So that I can simulate real application behaviors

  Scenario: Shopping cart workflow
    Given I create a stateful shopping cart mock
    When I request "GET /cart"
    Then the response should show an empty cart with count 0
    When I add item with name "Apple" and price "1.50"
    And I add second item with name "Banana" and price "0.75"
    Then the cart should contain 2 items
    And the initial cart total should be "2.25"
    When I remove the first item from the cart
    Then the cart should contain 1 item
    And the final cart total should be "0.75"

  Scenario: User session simulation
    Given I create a session-based authentication mock
    When I login with username "admin" and password "secret"
    Then I should receive a session token
    And the response should contain user info with role "administrator"
    When I request "/profile" with the session token
    Then I should get my profile information
    And the session should be marked as active
    When I logout with the session token
    Then the logout should be successful
    When I request "/profile" with the same token
    Then I should get a 401 unauthorized response

  Scenario: Multi-user state isolation
    Given I create a multi-user counter mock
    When user "alice" increments their counter 3 times
    And user "bob" increments their counter 2 times
    Then "alice"'s counter should be 3
    And "bob"'s counter should be 2
    And the summary should show 2 total users
    And the summary should show total counts of 5
    And each user's state should be independent
