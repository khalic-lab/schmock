Feature: HTTP Methods Support
  As a developer using Schmock
  I want to mock all standard HTTP methods
  So that I can fully simulate REST API behavior

  Background:
    Given I have a Schmock instance with routes:
      """
      {
        "routes": {
          "/api/users": {
            "data": [
              { "id": 1, "name": "John Doe" },
              { "id": 2, "name": "Jane Smith" }
            ]
          },
          "/api/users/1": {
            "data": { "id": 1, "name": "John Doe", "email": "john@example.com" }
          },
          "/api/users/2": {
            "data": { "id": 2, "name": "Jane Smith", "email": "jane@example.com" }
          }
        }
      }
      """

  Scenario: POST request creates a new resource
    When I make a POST request to "/api/users" with body:
      """
      {
        "name": "Bob Johnson",
        "email": "bob@example.com"
      }
      """
    Then the response status should be 201
    And the response should contain:
      """
      {
        "id": 3,
        "name": "Bob Johnson",
        "email": "bob@example.com"
      }
      """
    And the "request:start" event should be fired with method "POST"
    And the "request:end" event should be fired with status 201

  Scenario: PUT request updates an existing resource
    When I make a PUT request to "/api/users/1" with body:
      """
      {
        "id": 1,
        "name": "John Updated",
        "email": "john.updated@example.com"
      }
      """
    Then the response status should be 200
    And the response should contain:
      """
      {
        "id": 1,
        "name": "John Updated",
        "email": "john.updated@example.com"
      }
      """
    And the "request:start" event should be fired with method "PUT"
    And the "request:end" event should be fired with status 200

  Scenario: DELETE request removes a resource
    When I make a DELETE request to "/api/users/1"
    Then the response status should be 204
    And the response body should be empty
    And the "request:start" event should be fired with method "DELETE"
    And the "request:end" event should be fired with status 204

  Scenario: PATCH request partially updates a resource
    When I make a PATCH request to "/api/users/2" with body:
      """
      {
        "email": "jane.new@example.com"
      }
      """
    Then the response status should be 200
    And the response should contain:
      """
      {
        "id": 2,
        "name": "Jane Smith",
        "email": "jane.new@example.com"
      }
      """
    And the "request:start" event should be fired with method "PATCH"
    And the "request:end" event should be fired with status 200

  Scenario: POST to non-existent endpoint
    When I make a POST request to "/api/nonexistent" with body:
      """
      { "test": "data" }
      """
    Then the response status should be 404
    And the response should contain error "Not Found"

  Scenario: PUT to non-existent resource
    When I make a PUT request to "/api/users/999" with body:
      """
      { "name": "Ghost User" }
      """
    Then the response status should be 404
    And the response should contain error "Not Found"

  Scenario: DELETE non-existent resource
    When I make a DELETE request to "/api/users/999"
    Then the response status should be 404
    And the response should contain error "Not Found"

  Scenario: Request method is included in request event
    Given I register a handler for "request:start" event
    When I make a POST request to "/api/users" with body:
      """
      { "name": "Test User" }
      """
    Then the event data should contain request with method "POST"
    And the event data should contain the request body