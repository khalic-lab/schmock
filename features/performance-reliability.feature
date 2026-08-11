Feature: Performance and Reliability
  As a developer issuing concurrent requests
  I want each request to retain its own context
  So that asynchronous handlers cannot leak data between requests

  Scenario: Concurrent request contexts remain isolated
    Given I create an asynchronous mock that waits until every request reaches a shared rendezvous
    When I issue 50 concurrent requests with distinct route IDs
    Then every response should contain its corresponding route ID
    And the history should contain each route ID exactly once
