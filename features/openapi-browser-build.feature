Feature: OpenAPI Browser Build

  As a developer mocking an API inside a browser app built with esbuild, Vite or
  the Angular application builder
  I want openapi() with an inline spec to work with no Node built-ins
  So that my app bundles and boots instead of failing to resolve "path", or
  compiling and then dying on a dynamic require of "util" inside an app
  initializer, where the only symptom is that every data-driven page renders empty

  Scenario: An inline spec whose references point inside itself is served
    Given the browser build of the OpenAPI plugin
    When I create a mock from an inline spec with an internal reference
    Then the browser mock answers the route with 200
    And every item matches the referenced schema

  Scenario: A reference used in two places resolves to one shared object
    Given the browser build of the OpenAPI plugin
    When I create a mock from an inline spec reusing one component twice
    Then the browser mock answers the route with 200
    And both uses of the component produce the same fields

  Scenario: A spec given as a file path says so instead of failing silently
    Given the browser build of the OpenAPI plugin
    When I create a mock from a spec file path
    Then creating the mock fails with code OPENAPI_NODE_ONLY
    And the failure explains to pass the spec as an object

  Scenario: Strict validation says so instead of validating nothing
    Given the browser build of the OpenAPI plugin
    When I create a mock from an inline spec with strict validation
    Then creating the mock fails with code OPENAPI_NODE_ONLY
    And the failure mentions strict

  Scenario: External references say so instead of resolving to nothing
    Given the browser build of the OpenAPI plugin
    When I create a mock from an inline spec with external references enabled
    Then creating the mock fails with code OPENAPI_NODE_ONLY
    And the failure mentions external

  Scenario: A seed file path says so instead of seeding an empty collection
    Given the browser build of the OpenAPI plugin
    When I create a mock seeded from a file path
    Then creating the mock fails with code OPENAPI_NODE_ONLY
    And the failure explains to pass the seed inline

  Scenario: The reference policy still rules before the browser build gives up
    Given the browser build of the OpenAPI plugin
    When I create a mock from an inline spec with an unenabled external reference
    Then creating the mock fails with code OPENAPI_EXTERNAL_REF_BLOCKED

  Scenario: An unresolvable reference is reported rather than dropped
    Given the browser build of the OpenAPI plugin
    When I create a mock from an inline spec with a reference to nothing
    Then creating the mock fails
