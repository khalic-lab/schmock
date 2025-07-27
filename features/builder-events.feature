Feature: Builder Event System
  As a developer using the fluent API
  I want to listen to lifecycle events
  So that I can extend functionality and monitor requests

  Scenario: Listen to request events
    Given I create a mock with:
      """
      schmock()
        .routes({
          'GET /api/users': {
            response: () => [{ id: 1, name: 'John' }]
          }
        })
      """
    And I register handlers for "request:start" and "request:end" events
    When I request "GET /api/users"
    Then the "request:start" event should be fired with:
      """
      {
        "method": "GET",
        "path": "/api/users"
      }
      """
    And the "request:end" event should be fired with:
      """
      {
        "method": "GET",
        "path": "/api/users",
        "status": 200
      }
      """

  Scenario: Multiple event handlers
    Given I create a mock with:
      """
      schmock()
        .routes({
          'GET /test': {
            response: () => ({ data: 'test' })
          }
        })
      """
    And I register handlers "A" and "B" for "request:start" event in order
    When I request "GET /test"
    Then handler "A" should be called before handler "B"

  Scenario: Remove event handler
    Given I create a mock with:
      """
      schmock()
        .routes({
          'GET /test': {
            response: () => 'OK'
          }
        })
      """
    And I register a handler for "request:start" event
    And I remove the handler from "request:start" event
    When I request "GET /test"
    Then the handler should not be called

  Scenario: Error event
    Given I create a mock with:
      """
      schmock()
        .routes({
          'GET /error': {
            response: () => {
              throw new Error('Something went wrong')
            }
          }
        })
      """
    And I register a handler for "error" event
    When I request "GET /error"
    Then the "error" event should be fired with error "Something went wrong"