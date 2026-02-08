Feature: Watch Mode
  As a developer
  I want the CLI server to reload when the spec file changes
  So that I can iterate on my API spec without restarting

  Scenario: Server reloads with new routes after spec change
    Given a temp spec file with one route
    And a CLI server is started
    When the spec file is updated to include a new route
    And the server is reloaded
    Then the reloaded server is listening

  Scenario: Reload preserves the port
    Given a temp spec file with one route
    And a CLI server is started on a random port
    When the server is reloaded
    Then the port number is the same as before
