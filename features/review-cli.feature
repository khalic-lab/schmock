Feature: CLI review fixes
  As a developer running the Schmock CLI
  I want watch mode, the admin API and shutdown to behave predictably
  So that the mock never silently serves stale data, leaks credentials or hangs

  Scenario: Editing a referenced schema file reloads a spec loaded with external refs
    Given a temp spec whose response schema lives in a sibling schema file
    And a CLI server is started watching that spec with external refs
    When the sibling schema file is edited
    Then the response reflects the edited schema

  Scenario: Editing the seed manifest reloads the mock
    Given a seed manifest with inline pets
    And a CLI server is started watching the petstore spec with that seed manifest
    When the seed manifest is edited to seed a different pet
    Then the pet list serves the newly seeded pet

  Scenario: Editing a seed data file named by the manifest reloads the mock
    Given a seed manifest whose entry points at a sibling pets file
    And a CLI server is started watching the petstore spec with that seed manifest
    When the sibling pets file is edited to seed a different pet
    Then the pet list serves the newly seeded pet

  Scenario: A seed manifest broken and then fixed under watch recovers
    Given a seed manifest with inline pets
    And a CLI server is started watching the petstore spec with that seed manifest
    When the seed manifest is overwritten with invalid JSON
    Then the reload failure is reported
    And the pet list still serves the originally seeded pet
    When the seed manifest is edited to seed a different pet
    Then the pet list serves the newly seeded pet

  Scenario: A watch reload says that state and request history start empty
    Given a temp spec whose response schema lives in a sibling schema file
    And a CLI server is started watching that spec with external refs
    When the sibling schema file is edited
    Then the response reflects the edited schema
    And the reload notice says state and request history were reset

  Scenario: Writing a log or text file next to a spec loaded with external refs does not reload
    Given a temp spec whose response schema lives in a sibling schema file
    And a CLI server is started watching that spec with external refs
    When a log file and a text file are written next to the spec
    Then no reload is announced
    When the sibling schema file is edited
    Then the response reflects the edited schema

  Scenario: Admin history masks credential-shaped query parameters and headers
    Given a CLI server with the admin API and a known token
    When a client calls the mock with an api key in the query and in a custom header
    And the admin history is fetched with the token
    Then the recorded query masks "api_key" and "access_token"
    And the recorded query keeps "page" as "2"
    And the recorded headers mask "x-pet-key"
    And the recorded headers keep "x-trace" as "visible"

  Scenario: Closing the server settles when the runtime leaves a stalled upload open
    Given a CLI server with a short shutdown grace window
    And the runtime cannot force-close connections
    And a client has stalled halfway through a request body
    When the CLI server is closed
    Then the close settles within a few seconds

  Scenario: The startup banner brackets an IPv6 host
    Given the CLI is run bound to "::1"
    Then the startup banner prints a bracketed IPv6 URL

  # Review 2026-10-23

  Scenario: A seed manifest key named __proto__ is refused as an unknown resource
    Given a seed manifest that seeds pets under the key "__proto__"
    When a CLI server is created for the petstore spec with that seed manifest
    Then the server refuses to start with code "OPENAPI_UNKNOWN_SEED_RESOURCE"

  Scenario: An empty --seed value is refused instead of starting an unseeded server
    When the CLI is run on the petstore spec with the extra arguments "--seed="
    Then the run is refused with code "INVALID_CONFIG" for the flag "--seed"
    And no server is announced

  Scenario: The startup banner does not echo an admin token passed on the command line
    When the CLI is run on the petstore spec with the extra arguments "--admin --admin-token s3cretFromVault"
    Then the startup output does not contain "s3cretFromVault"
    And the startup output contains "Admin token: (from --admin-token)"

  Scenario: Admin history describes a binary upload by its size
    Given a CLI server with the admin API and a known token
    When a client posts 1000 bytes of application/octet-stream to the mock
    And the admin history is fetched with the token
    Then the recorded upload body reads as binary of 1000 bytes

  Scenario: --refs-allow-http without --refs-external warns that it has no effect
    When the CLI is run on the petstore spec with the extra arguments "--refs-allow-http schemas.example.com"
    Then the startup output contains "WARNING: --refs-allow-http has no effect without --refs-external"

  Scenario: An unbounded shutdown grace window is refused instead of cutting requests off at once
    When a CLI server is created for the petstore spec with a shutdown grace of "Infinity" milliseconds
    Then the server refuses to start with code "INVALID_CONFIG"

  Scenario: A spec directory deleted and recreated under watch is still watched
    Given a temp spec in its own directory serving "v1"
    And a CLI server is started watching that spec
    When the spec directory is deleted and recreated with the spec serving "v2"
    Then the thing endpoint serves "v2"
    When the recreated spec is edited to serve "v3"
    Then the edit is served as "v3"
