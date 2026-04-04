Feature: React Adapter
  As a React developer
  I want to use Schmock with React components
  So that I can mock API responses in my React applications

  Scenario: SchmockProvider intercepts fetch calls
    Given a Schmock instance with route "GET /api/users" returning users
    When I render a component that fetches "/api/users" inside SchmockProvider
    Then the component should display the mocked users

  Scenario: SchmockProvider restores fetch on unmount
    Given a Schmock instance with route "GET /api/users" returning users
    When I mount and unmount a SchmockProvider
    Then fetch should be restored to the original implementation

  Scenario: Passthrough for unmatched routes
    Given a Schmock instance with route "GET /api/users" returning users
    And the provider is configured with passthrough enabled
    When the component fetches "/api/other"
    Then the request should pass through to the original fetch

  Scenario: Error status codes flow through correctly
    Given a Schmock instance with a route returning status 404
    When I render a component that fetches that route inside SchmockProvider
    Then the component should receive the error status

  Scenario: POST with JSON body works through the provider
    Given a Schmock instance with a POST route that echoes the body
    When I render a component that posts data inside SchmockProvider
    Then the component should display the echoed data

  Scenario: useSchmock throws outside SchmockProvider
    Given a component that calls useSchmock without a provider
    When I try to render it
    Then it should throw an error mentioning SchmockProvider
