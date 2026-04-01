Feature: Vue Adapter
  As a Vue developer
  I want to use Schmock with Vue components
  So that I can mock API responses in my Vue applications

  Scenario: SchmockPlugin intercepts fetch calls
    Given a Schmock instance with route "GET /api/users" returning users
    When I mount a component that fetches "/api/users" with the Schmock plugin
    Then the component should display the mocked users

  Scenario: Plugin restores fetch on app unmount
    Given a Schmock instance with route "GET /api/users" returning users
    When I mount and unmount a Vue app with the Schmock plugin
    Then fetch should be restored to the original implementation

  Scenario: useSchmock returns the mock instance
    Given a Schmock instance
    When I use the useSchmock composable inside a component with the plugin
    Then it should receive the CallableMockInstance

  Scenario: Passthrough for unmatched routes
    Given a Schmock instance with route "GET /api/users" returning users
    And the plugin is configured with passthrough enabled
    When the component fetches "/api/other"
    Then the request should pass through to the original fetch
