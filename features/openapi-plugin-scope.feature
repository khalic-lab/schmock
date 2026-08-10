Feature: OpenAPI Plugin Route Ownership

  As a developer piping an OpenAPI plugin onto a mock that also has other routes
  I want the plugin to only inspect the routes it registered from its own spec
  So that manual routes and other plugins' routes are not validated, secured or
  negotiated against a spec they have nothing to do with

  Scenario: A manually registered route is untouched by the OpenAPI plugin
    Given a mock with a secured spec and a manually registered route
    When I request the manual route without credentials
    Then the scope response status is 200
    And the scope response body is the manual payload
    When I request the spec route without credentials
    Then the scope response status is 401

  Scenario: Two OpenAPI plugins do not cross-apply security
    Given a mock piping a secured spec and an unsecured spec on disjoint paths
    When I request the unsecured plugin's route without credentials
    Then the scope response status is 200
    When I request the secured plugin's route without credentials
    Then the scope response status is 401

  Scenario: A second OpenAPI plugin does not dispatch another plugin's callbacks
    Given a mock piping a callback-declaring spec and a second spec owning the dispatcher
    When I post an order with a callback url
    Then the scope response status is 201
    And the callback dispatcher was never called

  Scenario: Request media type checks do not reach a manually registered route
    Given a mock with a validating spec and a manually registered POST route
    When I post to the manual route with an undeclared content type
    Then the scope response status is 200
    And the scope response body is the manual payload
    When I post to the spec route with an undeclared content type
    Then the scope response status is 415

  Scenario: Prefer header is ignored on non-OpenAPI routes
    Given a mock with a secured spec and a manually registered route
    When I request the manual route with header prefer code 404
    Then the scope response status is 200
    And the scope response body is the manual payload
