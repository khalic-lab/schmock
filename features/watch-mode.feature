Feature: Watch Mode
  As a developer
  I want the CLI server to reload when the spec file changes
  So that I can iterate on my API spec without restarting

  Scenario: Watching enabled through createCliServer reloads on a spec change
    Given a temp spec file with one route
    And a CLI server is started with file watching
    When the spec file is updated to include a new route
    Then the new route responds successfully on the original port

  Scenario: A reload keeps the listening socket bound
    Given a temp spec file with one route
    And a CLI server is started with file watching
    And a client keeps a connection open to the CLI server
    When the spec file is updated to include a new route
    Then the new route responds successfully on the original port
    And the connection opened before the reload still serves requests

  Scenario: Invalid spec changes keep the current server online
    Given a temp spec file with one route
    And a CLI server is started with file watching
    When the spec file is changed to invalid JSON
    Then the original route remains available after the failed reload

  Scenario: The admin token survives a reload
    Given a temp spec file with one route
    And a CLI server is started with file watching and the admin API
    When the spec file is updated to include a new route
    Then the new route responds successfully on the original port
    And the admin API still accepts the token issued at startup
