Feature: Express error provenance survives response hooks
  As an Express developer using errorFormatter
  I want internal exceptions to stay recognisable after beforeResponse runs
  So that my custom error format is never silently bypassed

  Scenario: A spread-style beforeResponse does not suppress errorFormatter
    Given an Express mock whose route throws and a beforeResponse that spreads the response
    When I send an Express request to "GET /api/boom"
    Then the Express response status is 500
    And the Express response body is the formatted error
    And the Express response body is not the raw core error body

  Scenario: Response headers survive onto the formatted error
    Given an Express mock whose route throws and a beforeResponse that adds a retry-after header
    When I send an Express request to "GET /api/boom"
    Then the Express response status is 500
    And the Express response body is the formatted error
    And the Express response header "retry-after" is "30"
    And the Express response header "content-type" starts with "application/json"

  Scenario: A beforeResponse that rewrites the status is respected
    Given an Express mock whose route throws and a beforeResponse that rewrites the status to 503
    When I send an Express request to "GET /api/boom"
    Then the Express response status is 503
    And the Express error formatter was not called

  Scenario: A deliberate domain 500 is never reformatted
    Given an Express mock returning a deliberate 500 domain body
    When I send an Express request to "GET /api/declined"
    Then the Express response status is 500
    And the Express error formatter was not called
    And the Express response body is the raw domain body
