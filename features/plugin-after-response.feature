Feature: Settling a request after its response is final
  As a plugin author
  I want a hook that runs once a matched request's final response is known
  So that work staged during the request is committed only when the client is told it succeeded

  # Design decision #39: process() runs before the plugins piped after it, so
  # a write committed there survives a later plugin's 500. afterResponse runs
  # after the whole pipeline, the 500 of a failure and the response delay, and
  # is skipped for a request aborted before that point. context.state is the
  # same Map as the generator's pluginState, so staged work is reachable.

  Scenario: A staged write is committed when the final response succeeds
    Given a store plugin that commits staged rows in afterResponse when the status is below 400
    And a route "POST /pets" that stages the request body as a row and answers 201
    When I request "POST /pets" with body "rex"
    Then the response status is 201
    And the store holds the rows "rex"

  Scenario: A staged write is dropped when a plugin piped later answers 500
    Given a store plugin that commits staged rows in afterResponse when the status is below 400
    And a route "POST /pets" that stages the request body as a row and answers 201
    And a plugin piped after the store that answers every request with 500
    When I request "POST /pets" with body "rex"
    Then the response status is 500
    And the store holds no rows
    And afterResponse saw the final status 500

  Scenario: afterResponse sees the 500 a throwing route was answered with
    Given a store plugin that commits staged rows in afterResponse when the status is below 400
    And a route "POST /pets" that stages a row and then throws
    When I request "POST /pets" with body "rex"
    Then the response status is 500
    And the store holds no rows
    And afterResponse saw the final status 500

  Scenario: afterResponse is skipped for a request aborted during its delay
    Given a store plugin that commits staged rows in afterResponse when the status is below 400
    And a route "POST /pets" with a 1000 ms delay that stages the request body as a row
    When I abort a "POST /pets" request with body "rex" while it waits
    Then the request rejects with an AbortError
    And the store holds no rows
    And afterResponse never ran

  Scenario: A throwing afterResponse never changes the response
    Given a route "GET /health" that answers ok
    And a plugin whose afterResponse throws
    When I request "GET /health"
    Then the response status is 200
    And the request is recorded in history
