Feature: State Isolation Under Concurrency
  As a developer using stateful mocks concurrently
  I want state ownership boundaries to remain explicit
  So that requests and mock instances cannot leak state into one another

  Scenario: Different mock instances keep independent route state
    Given I create two mocks with different counter state
    When I increment both mocks concurrently
    Then the first mock counter should be 1
    And the second mock counter should be 101

  Scenario: Concurrent requests keep plugin state isolated
    Given I create a two-stage plugin pipeline with a shared async barrier
    When I issue 20 concurrent requests with distinct IDs through the pipeline
    Then every response should contain the same ID from both plugin stages
