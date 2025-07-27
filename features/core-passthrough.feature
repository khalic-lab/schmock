Feature: Core Passthrough Behavior
  As a developer
  I want the core to return configured data by default
  So that I have zero-config mocking

  Scenario: Return static object data without plugins
    Given a Schmock instance with routes:
      """
      {
        "routes": {
          "/api/users": { "data": [{"id": 1, "name": "John"}] }
        }
      }
      """
    When I process "/api/users"
    Then I should receive:
      """
      [{"id": 1, "name": "John"}]
      """

  Scenario: Return string value directly
    Given a Schmock instance with routes:
      """
      {
        "routes": {
          "/api/status": "OK"
        }
      }
      """
    When I process "/api/status"
    Then I should receive the string "OK"

  Scenario: Return number value directly
    Given a Schmock instance with routes:
      """
      {
        "routes": {
          "/api/count": 42
        }
      }
      """
    When I process "/api/count"
    Then I should receive the number 42

  Scenario: Return boolean value directly
    Given a Schmock instance with routes:
      """
      {
        "routes": {
          "/api/feature": true
        }
      }
      """
    When I process "/api/feature"
    Then I should receive the boolean true

  Scenario: Return null value
    Given a Schmock instance with routes:
      """
      {
        "routes": {
          "/api/empty": null
        }
      }
      """
    When I process "/api/empty"
    Then I should receive null

  Scenario: No route found throws error
    Given a Schmock instance with routes:
      """
      {
        "routes": {
          "/api/users": { "data": [] }
        }
      }
      """
    When I process "/api/unknown"
    Then an error should be thrown with message "No route matches path: /api/unknown"

  Scenario: Route with no data returns undefined
    Given a Schmock instance with routes:
      """
      {
        "routes": {
          "/api/dynamic": {}
        }
      }
      """
    When I process "/api/dynamic"
    Then I should receive undefined