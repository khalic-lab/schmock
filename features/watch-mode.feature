Feature: Watch Mode
  As a developer
  I want the CLI server to reload when the spec file changes
  So that I can iterate on my API spec without restarting

  Scenario: Spec changes reload automatically on the same port
    Given a temp spec file with one route
    And a CLI server is started with file watching
    When the spec file is updated to include a new route
    Then the server reloads automatically on the original port
    And the new route responds successfully

  Scenario: Invalid spec changes keep the current server online
    Given a temp spec file with one route
    And a CLI server is started with file watching
    When the spec file is changed to invalid JSON
    Then the original route remains available after the failed reload
