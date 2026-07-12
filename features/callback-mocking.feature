Feature: Callback/Webhook Mocking
  As a developer
  I want the mock to fire callbacks defined in the spec
  So that webhook integrations can be tested

  Scenario: Callback dispatches after resource creation when explicitly enabled
    Given a mock with a spec defining a callback on POST
    And an application callback dispatcher is configured
    When I create a resource with a callback URL
    Then the dispatcher gets a POST callback request

  Scenario: Callbacks are disabled by default
    Given a mock with a spec defining a callback on POST
    And no application callback dispatcher is configured
    When I create a resource with a callback URL
    Then no callback request is dispatched

  Scenario: Invalid responses do not dispatch callbacks
    Given a mock with a callback and response validation enabled
    And an application callback dispatcher is configured
    When I create a resource with a callback URL
    Then the response status is 500
    And no callback request is dispatched

  Scenario: Missing callback URL is silently skipped
    Given a mock with a spec defining a callback on POST
    And an application callback dispatcher is configured
    When I create a resource without a callback URL
    Then the response status is 201
    And no callback request is dispatched

  Scenario: Callback expressions follow JSON Pointer escaping and array indexes
    Given a mock with a spec defining a callback on POST
    And an application callback dispatcher is configured
    When I create a resource with a callback URL under an escaped array key
    Then the dispatcher gets callback URL "https://callbacks.example.test/nested"
