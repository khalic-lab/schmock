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

  Scenario: useSchmock throws without the plugin
    Given a component that calls useSchmock without the plugin
    When I try to mount it
    Then it should throw an error mentioning schmockPlugin
