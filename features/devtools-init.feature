Feature: Service worker init command
  As a developer enabling the service worker relay
  I want one command that copies the Schmock service worker into my public directory
  So that the script my page registers always matches the installed library

  Scenario: init copies the worker script into the public directory
    Given an empty project directory
    When I run "schmock-devtools init public"
    Then the command exits with code 0
    And "public/schmock-sw.js" is identical to the packaged worker
    And the output names "public/schmock-sw.js" and "await startServiceWorkerRelay()"

  Scenario: init creates a missing public directory
    Given an empty project directory
    When I run "schmock-devtools init static/assets"
    Then the command exits with code 0
    And "static/assets/schmock-sw.js" is identical to the packaged worker

  Scenario: init replaces an outdated worker
    Given a project whose "public/schmock-sw.js" contains "old worker"
    When I run "schmock-devtools init public"
    Then "public/schmock-sw.js" is identical to the packaged worker

  Scenario: init without a directory prints usage and fails
    Given an empty project directory
    When I run "schmock-devtools init"
    Then the command exits with code 1
    And the error output contains "Usage: schmock-devtools init <publicDir>"

  Scenario: An unknown command prints usage and fails
    Given an empty project directory
    When I run "schmock-devtools serve public"
    Then the command exits with code 1
    And the error output contains "Usage: schmock-devtools init <publicDir>"

  Scenario: help prints usage
    Given an empty project directory
    When I run "schmock-devtools --help"
    Then the command exits with code 0
    And the output contains "Usage: schmock-devtools init <publicDir>"

  Scenario: A missing packaged worker is reported
    Given an empty project directory and no packaged worker
    When I run "schmock-devtools init public"
    Then the command exits with code 1
    And the error output names the missing packaged worker
