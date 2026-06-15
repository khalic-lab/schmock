Feature: onError tuple recovery in plugin pipeline
  As a plugin author
  I want to return a status tuple from onError
  So that a failed plugin can recover with a specific HTTP status and body

  Scenario: 2-element tuple from onError recovers with correct status and body
    Given a mock with a plugin whose process throws and onError returns a 2-element tuple
    When I handle a request to "GET /fail"
    Then the response status is 503
    And the response body is '{"error":"recovered"}'
    And no error is thrown

  Scenario: 3-element tuple from onError recovers and includes custom headers
    Given a mock with a plugin whose process throws and onError returns a 3-element tuple with headers
    When I handle a request to "GET /fail-with-headers"
    Then the response status is 503
    And the response body is '{"error":"recovered with headers"}'
    And no error is thrown
