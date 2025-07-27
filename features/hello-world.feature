Feature: Static Mocking

  As a developer,
  I want to define a mock API route that returns a simple, hardcoded JSON object,
  so that I can get a predictable endpoint running in under 30 seconds for my frontend to connect to.

  Scenario: Mocking a GET request
    Given a Schmock instance with the following configuration:
      """
      {
        "routes": {
          "/api/user": {
            "data": { "id": 1, "name": "John Doe" }
          }
        }
      }
      """
    When I make a GET request to "/api/user"
    Then the response status code should be 200
    And the response body should be:
      """
      {
        "id": 1,
        "name": "John Doe"
      }
      """
