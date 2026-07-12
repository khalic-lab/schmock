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

  Scenario: useSchmock throws outside SchmockProvider
    Given a component that calls useSchmock without a provider
    When I try to render it
    Then it should throw an error mentioning SchmockProvider

  Scenario: Provider applies a new request hook after rerender
    Given a provider request hook that marks requests as "first"
    When I rerender the provider with a hook that marks requests as "second"
    Then subsequent requests should use the "second" hook

  Scenario: Descendant layout effects see interception on the first commit
    Given a Schmock instance with a route for a layout-effect request
    When I render a layout-effect fetcher inside SchmockProvider
    Then the layout-effect fetcher should display the mocked value
