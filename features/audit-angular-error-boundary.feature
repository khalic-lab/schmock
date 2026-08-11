Feature: Angular adapter error boundary
  As an Angular developer using errorFormatter
  I want every adapter failure to surface as a shaped HttpErrorResponse
  So that a throwing hook never escapes as a bare Error or bypasses my format

  Scenario: A throwing transformRequest yields a formatted HttpErrorResponse
    Given an Angular mock with a transformRequest that throws and a custom errorFormatter
    When I make an Angular boundary request to "GET /api/users"
    Then the Angular boundary result is an HttpErrorResponse
    And the Angular boundary error status is 500
    And the Angular boundary error body uses the custom error format

  Scenario: A spread-style transformResponse does not suppress errorFormatter
    Given an Angular mock whose route throws and a transformResponse that spreads the response
    When I make an Angular boundary request to "GET /api/boom"
    Then the Angular boundary result is an HttpErrorResponse
    And the Angular boundary error status is 500
    And the Angular boundary error body uses the custom error format

  Scenario: A deliberate domain 500 is never reformatted
    Given an Angular mock returning a deliberate 500 domain body
    When I make an Angular boundary request to "GET /api/declined"
    Then the Angular boundary result is an HttpErrorResponse
    And the Angular boundary error status is 500
    And the Angular boundary error formatter was not called
