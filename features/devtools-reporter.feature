Feature: DevTools reporter plugin
  As a developer mocking a browser app with Schmock
  I want every request a mock answers reported in Chrome DevTools
  So that I can inspect mocked traffic that the Network panel never sees

  Scenario: A mocked fetch is logged as one collapsed console group
    Given a mock with route "GET /api/users" returning users and the devtools plugin
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/users"
    Then exactly 1 collapsed console group was opened and closed
    And the group title reads "Schmock GET http://localhost/api/users → 200" followed by the duration
    And the group logs the request "GET http://localhost/api/users"
    And the group logs the response status 200 with the mocked users

  Scenario: A same-origin request is labelled by its path and query
    Given the page is served from "http://localhost"
    And a mock with route "GET /api/users" returning users and the devtools plugin
    And the mock intercepts fetch
    When the app fetches "/api/users?page=2"
    Then the group title reads "Schmock GET /api/users?page=2 → 200" followed by the duration
    And exactly 1 performance measure named "GET /api/users?page=2" was recorded

  Scenario: A mocked fetch adds an entry to the Schmock performance track
    Given a mock with route "GET /api/users" returning users and the devtools plugin
    And an exchange observer piped into the mock
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/users"
    Then exactly 1 performance measure named "GET http://localhost/api/users" was recorded
    And the measure is a track entry on track "Schmock" colored "primary"
    And the measure lists the property "Outcome" as "200"
    And the measure spans the observed exchange

  Scenario: A client error is colored as a warning
    Given a mock with route "GET /api/users" returning users and the devtools plugin
    And the mock intercepts fetch with passthrough disabled
    When the app fetches "http://localhost/api/missing"
    Then the group title reads "Schmock GET http://localhost/api/missing → 404" followed by the duration
    And the measure is a track entry on track "Schmock" colored "tertiary"

  Scenario: A server error is colored as an error
    Given a mock with route "GET /api/fail" answering status 503 and the devtools plugin
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/fail"
    Then the group title reads "Schmock GET http://localhost/api/fail → 503" followed by the duration
    And the measure is a track entry on track "Schmock" colored "error"

  Scenario: A failed fetch logs its error inside the group
    Given a mock with route "GET /api/users" returning users and the devtools plugin
    And the mock intercepts fetch with a beforeResponse hook that throws "hook failed"
    When the app fetches "http://localhost/api/users" expecting a rejection
    Then the group title reads "Schmock GET http://localhost/api/users → failed: hook failed" followed by the duration
    And the group logs the error "hook failed"
    And the measure is a track entry on track "Schmock" colored "error"

  Scenario: An aborted fetch is labelled aborted
    Given a mock with route "GET /api/slow" that waits until released and the devtools plugin
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/slow" and aborts it while the route runs
    Then the group title reads "Schmock GET http://localhost/api/slow → aborted" followed by the duration
    And the measure is a track entry on track "Schmock" colored "secondary"

  Scenario: A request passed on to the network is not reported
    Given a mock with route "GET /api/users" returning users and the devtools plugin
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/other"
    Then no console group was opened
    And no performance measure was recorded

  Scenario: One fetch is reported once even when another mock misses it first
    Given a mock "answering" with route "GET /api/users" returning users and the devtools plugin
    And a mock "missing" with no routes and the devtools plugin
    And mock "answering" intercepts fetch
    And mock "missing" intercepts fetch
    When the app fetches "http://localhost/api/users"
    Then exactly 1 collapsed console group was opened and closed
    And exactly 1 performance measure named "GET http://localhost/api/users" was recorded

  Scenario: The track name and group label both outputs
    Given a mock with route "GET /api/users" returning users and the devtools plugin configured with:
      """
      { "track": "Users API", "trackGroup": "My app" }
      """
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/users"
    Then the group title reads "Users API GET http://localhost/api/users → 200" followed by the duration
    And the measure is a track entry on track "Users API" colored "primary"
    And the measure belongs to the track group "My app"

  Scenario: Console reporting can be turned off
    Given a mock with route "GET /api/users" returning users and the devtools plugin configured with:
      """
      { "console": false }
      """
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/users"
    Then no console group was opened
    And exactly 1 performance measure named "GET http://localhost/api/users" was recorded

  Scenario: Performance reporting can be turned off
    Given a mock with route "GET /api/users" returning users and the devtools plugin configured with:
      """
      { "performance": false }
      """
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/users"
    Then exactly 1 collapsed console group was opened and closed
    And no performance measure was recorded

  Scenario: A failing performance API does not stop console reporting
    Given a mock with route "GET /api/users" returning users and the devtools plugin
    And performance.measure throws
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/users"
    Then exactly 1 collapsed console group was opened and closed
    And the fetch caller received status 200

  Scenario: The plugin leaves mocked responses unchanged
    Given a mock with route "GET /api/users" returning users and the devtools plugin
    And the mock intercepts fetch
    When the app fetches "http://localhost/api/users"
    Then the fetch caller received status 200 with the mocked users

  Scenario: Invalid options are rejected when the plugin is created
    When the devtools plugin is created with:
      """
      { "track": "" }
      """
    Then creating the plugin throws a SchmockError with code "DEVTOOLS_CONFIG_INVALID"
