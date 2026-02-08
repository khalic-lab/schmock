Feature: Callback/Webhook Mocking
  As a developer
  I want the mock to fire callbacks defined in the spec
  So that webhook integrations can be tested

  Scenario: Callback fires after resource creation
    Given a mock with a spec defining a callback on POST
    And a callback receiver is listening
    When I create a resource with a callback URL
    Then the callback receiver gets a POST request

  Scenario: Missing callback URL is silently skipped
    Given a mock with a spec defining a callback on POST
    When I create a resource without a callback URL
    Then no error is raised
