Feature: Review fixes for release and developer tooling
  As a maintainer of Schmock
  I want the release gate, the pre-commit hook and the benchmarks to measure what they claim
  So that a green local check means the source being committed or released works

  Scenario: The browser gate rejects a Node built-in that is not on the allowlist
    Given an esbuild metafile whose bundle imports "node:http" and "node:util" as externals
    When I check it with the browser Node-import gate allowing only "node:http"
    Then the gate fails and names "node:util"

  Scenario: The browser gate accepts a bundle whose only Node import is allowlisted
    Given an esbuild metafile whose bundle imports "node:http" as an external
    When I check it with the browser Node-import gate allowing only "node:http"
    Then the gate passes

  Scenario: The browser gate treats a bare built-in as a Node import
    Given an esbuild metafile whose bundle imports "util" as an external
    When I check it with the browser Node-import gate allowing only "node:http"
    Then the gate fails and names "util"

  Scenario: Both browser bundles of the release candidate go through the Node-import gate
    Given the release-candidate check script
    Then both browser stages are bundled by esbuild with a metafile
    And each metafile is checked by the browser Node-import gate

  Scenario: Downstream package suites resolve sibling packages to their source
    Given the unit and BDD vitest configs of faker, openapi, validation, query, react and vue
    When each config resolves the @schmock packages that package imports
    Then every one resolves into the sibling package's src directory

  Scenario: The publish entry point builds before it runs the test suite
    Given the publish entry point with every external command stubbed
    When I run it with no arguments
    Then "bun run build" runs before "bun run test:all"

  Scenario: The guarded publish script builds before it runs the test suite
    Given the guarded publish script
    Then its validation block runs "bun run build" before "bun run test:all"

  Scenario: The pre-commit hook does not run an unenforced benchmark
    Given the pre-commit hook with every external command stubbed
    When I run the hook
    Then it runs lint and the quiet test suite
    And it does not run the benchmark

  Scenario: The pre-commit hook reports unstaged changes as the developer's own
    Given the pre-commit hook with every external command stubbed
    And the working tree has unstaged changes
    When I run the hook
    Then it fails with a message about unstaged changes
    And it does not claim that linting changed files

  Scenario: The route lookup benchmark exercises the param-route scan
    Given the throughput benchmark's param-route mock with 2000 routes
    When I request the last param route and a path that matches no route
    Then the last route answers with its captured param
    And the miss answers 404

  Scenario: The bundle-size benchmark counts only shipped JavaScript
    Given a dist directory with a JS file, a declaration, a declaration map and a source map
    When the bundle-size benchmark measures its JavaScript
    Then only the JS file's bytes are counted
