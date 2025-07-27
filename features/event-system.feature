Feature: Event System
  As a plugin developer
  I want to listen to Schmock events during the request lifecycle
  So that I can extend functionality and track request processing

  Background:
    Given I have a Schmock instance with routes:
      """
      {
        "routes": {
          "/api/users": { "data": [{ "id": 1, "name": "John" }] },
          "/api/posts": { "data": [{ "id": 1, "title": "Hello World" }] }
        }
      }
      """

  Scenario: Register and trigger request:start event
    Given I register a handler for "request:start" event
    When I make a GET request to "/api/users"
    Then the "request:start" event should be fired
    And the event data should contain request and route information

  Scenario: Register and trigger request:end event
    Given I register a handler for "request:end" event
    When I make a GET request to "/api/users"
    Then the "request:end" event should be fired
    And the event data should contain request and response information

  Scenario: Multiple handlers for the same event
    Given I register two handlers for "request:start" event
    When I make a GET request to "/api/users"
    Then both handlers should receive the event in registration order

  Scenario: Remove event handler
    Given I register a handler for "request:start" event
    And I remove the handler from "request:start" event
    When I make a GET request to "/api/users"
    Then the removed handler should not be called

  Scenario: Plugin registration event
    Given I register a handler for "plugin:registered" event
    When I register a plugin with name "test-plugin"
    Then the "plugin:registered" event should be fired
    And the event data should contain the plugin information

  Scenario: Error event handling
    Given I register a handler for "error" event
    When an error occurs during request processing
    Then the "error" event should be fired
    And the event data should contain the error details

  Scenario: Event handler execution order
    Given I register handlers for "request:start" and "request:end" events
    When I make a GET request to "/api/users"
    Then "request:start" should fire before "request:end"
    And both events should contain the same request object