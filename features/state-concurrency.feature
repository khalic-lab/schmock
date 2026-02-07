Feature: State Management and Concurrency
  As a developer using Schmock
  I want reliable state management under concurrent access
  So that my stateful mocks behave predictably in multi-threaded scenarios

  Scenario: Concurrent state updates with race conditions
    Given I create a mock with a shared counter state
    When I make 5 concurrent increment requests
    Then all requests should complete successfully
    And the final counter should reflect all increments
    And each response should show sequential progression

  Scenario: Concurrent access to different state properties
    Given I create a mock with separate user, post, and comment counters
    When I make concurrent requests to different endpoints
    Then each endpoint should maintain its own counter correctly
    And the final state should show accurate counts for all properties

  Scenario: State isolation between different mock instances
    Given I create two separate mock instances with independent state
    When I update state in both mock instances concurrently
    Then each mock instance should maintain its own isolated state
    And changes in one instance should not affect the other

  Scenario: Concurrent plugin state modifications
    Given I create a mock with stateful counter and tracker plugins
    When I make concurrent requests through the plugin pipeline
    Then each plugin should correctly update its state counters
    And the global request count should be accurate
    And plugin state should not interfere with each other

  Scenario: State persistence across request contexts
    Given I create a mock with persistent session state
    When I simulate concurrent user login and logout operations
    Then session state should be maintained correctly across requests
    And active user count should remain consistent
    And session cleanup should work properly

  Scenario: Large state object concurrent modifications
    Given I create a mock with a large 1000-item data array
    When I make concurrent updates to different parts of large state
    Then all updates should be applied correctly
    And statistics should reflect the correct aggregated values
    And no data corruption should occur

  Scenario: State cleanup and memory management
    Given I create a mock with LRU cache state
    When I add items to cache beyond the size limit concurrently
    Then the cache should maintain its size limit
    And old items should be evicted properly
    And cache size should remain consistent

  Scenario: Nested state object concurrent access
    Given I create a mock with deeply nested user state
    When I make concurrent updates to different nested state sections
    Then each nested section should be updated independently
    And no cross-contamination should occur between user data
    And nested state structure should remain intact

  Scenario: State rollback on plugin errors
    Given I create a mock with an error-prone transaction plugin
    When I make concurrent transactions including some that should fail
    Then successful transactions should update state correctly
    And failed transactions should not modify state
    And final balance should reflect only successful transactions
    And transaction history should be consistent
