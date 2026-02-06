Feature: Error Handling
  As a developer using Schmock
  I want comprehensive error handling and clear error messages
  So that I can quickly diagnose and fix issues in my mocks

  Scenario: Route not found returns 404
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /users', [{ id: 1, name: 'John' }])
      """
    When I request "GET /posts"
    Then I should receive status 404
    And the response should contain error "Route not found: GET /posts"
    And the response should have error code "ROUTE_NOT_FOUND"

  Scenario: Wrong HTTP method returns 404
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /api/data', { success: true })
      """
    When I request "POST /api/data"
    Then I should receive status 404
    And the response should contain error "Route not found: POST /api/data"

  Scenario: Invalid route key throws RouteDefinitionError
    Given I attempt to create a mock with invalid route:
      """
      const mock = schmock()
      mock('INVALID_METHOD /path', 'response')
      """
    Then it should throw a RouteDefinitionError
    And the error message should contain "Invalid HTTP method"

  Scenario: Empty route path throws RouteDefinitionError
    Given I attempt to create a mock with empty path:
      """
      const mock = schmock()
      mock('GET ', 'response')
      """
    Then it should throw a RouteDefinitionError
    And the error message should contain "Invalid route format"

  Scenario: Plugin throws error returns 500 with PluginError
    Given I create a mock with failing plugin:
      """
      const mock = schmock()
      const failingPlugin = {
        name: 'failing-plugin',
        process: () => { throw new Error('Plugin failed') }
      }
      mock('GET /test', 'original').pipe(failingPlugin)
      """
    When I request "GET /test"
    Then I should receive status 500
    And the response should contain error 'Plugin "failing-plugin" failed: Plugin failed'
    And the response should have error code "PLUGIN_ERROR"

  Scenario: Plugin onError hook recovers from failure
    Given I create a mock with recoverable plugin:
      """
      const mock = schmock()
      const recoverablePlugin = {
        name: 'recoverable',
        process: () => { throw new Error('Initial failure') },
        onError: () => ({ status: 200, body: 'recovered', headers: {} })
      }
      mock('GET /test', 'original').pipe(recoverablePlugin)
      """
    When I request "GET /test"
    Then I should receive status 200
    And I should receive text "recovered"

  Scenario: Plugin returns invalid result structure
    Given I create a mock with invalid plugin:
      """
      const mock = schmock()
      const invalidPlugin = {
        name: 'invalid',
        process: () => ({ wrongStructure: true })
      }
      mock('GET /test', 'original').pipe(invalidPlugin)
      """
    When I request "GET /test"
    Then I should receive status 500
    And the response should contain error "didn't return valid result"

  Scenario: Function generator throws error returns 500
    Given I create a mock with failing generator:
      """
      const mock = schmock()
      mock('GET /fail', () => { throw new Error('Generator failed') })
      """
    When I request "GET /fail"
    Then I should receive status 500
    And the response should contain error "Generator failed"
    And the response should have error code "INTERNAL_ERROR"

  Scenario: Invalid JSON generator with JSON content-type throws RouteDefinitionError
    Given I attempt to create a mock with invalid JSON:
      """
      const mock = schmock()
      const circularRef = {}
      circularRef.self = circularRef
      mock('GET /invalid', circularRef, { contentType: 'application/json' })
      """
    Then it should throw a RouteDefinitionError
    And the error message should contain "not valid JSON"

  Scenario: Namespace mismatch returns 404
    Given I create a mock with namespace:
      """
      const mock = schmock({ namespace: '/api/v1' })
      mock('GET /users', [{ id: 1 }])
      """
    When I request "GET /users"
    Then I should receive status 404
    And the response should contain error "Route not found: GET /users"

  Scenario: Multiple plugin failures cascade properly
    Given I create a mock with multiple failing plugins:
      """
      const mock = schmock()
      const plugin1 = {
        name: 'first-fail',
        process: () => { throw new Error('First error') }
      }
      const plugin2 = {
        name: 'second-fail', 
        process: () => { throw new Error('Second error') }
      }
      mock('GET /cascade', 'original').pipe(plugin1).pipe(plugin2)
      """
    When I request "GET /cascade"
    Then I should receive status 500
    And the response should contain error 'Plugin "first-fail" failed'

  Scenario: Plugin onError hook also fails
    Given I create a mock with broken error handler:
      """
      const mock = schmock({ debug: true })
      const brokenPlugin = {
        name: 'broken-handler',
        process: () => { throw new Error('Process failed') },
        onError: () => { throw new Error('Handler failed') }
      }
      mock('GET /broken', 'original').pipe(brokenPlugin)
      """
    When I request "GET /broken"
    Then I should receive status 500
    And the response should contain error 'Plugin "broken-handler" failed'

  Scenario: Empty parameter in route returns 404
    Given I create a mock with parameterized route:
      """
      const mock = schmock()
      mock('GET /users/:id', ({ params }) => ({ userId: params.id }))
      """
    When I request "GET /users/"
    Then I should receive status 404
    And the response should contain error "Route not found: GET /users/"

  Scenario: Async generator error handling
    Given I create a mock with failing async generator:
      """
      const mock = schmock()
      mock('GET /async-fail', async () => { 
        await new Promise(resolve => setTimeout(resolve, 10))
        throw new Error('Async generator failed') 
      })
      """
    When I request "GET /async-fail"
    Then I should receive status 500
    And the response should contain error "Async generator failed"

  Scenario: Error responses include proper headers
    Given I create a mock with failing route:
      """
      const mock = schmock()
      mock('GET /error', () => { throw new Error('Test error') })
      """
    When I request "GET /error"
    Then I should receive status 500
    And the content-type should be "application/json"
    And the response body should be valid JSON

  Scenario: Plugin onError returns response with status 0
    Given I create a mock with status-zero error handler:
      """
      const mock = schmock()
      const plugin = {
        name: 'zero-status',
        process: () => { throw new Error('fail') },
        onError: () => ({ status: 0, body: 'zero status', headers: {} })
      }
      mock('GET /zero', 'original').pipe(plugin)
      """
    When I request "GET /zero"
    Then I should receive status 0
    And I should receive text "zero status"

  Scenario: Plugin null/undefined return handling
    Given I create a mock with null-returning plugin:
      """
      const mock = schmock()
      const nullPlugin = {
        name: 'null-plugin',
        process: () => null
      }
      mock('GET /null', 'original').pipe(nullPlugin)
      """
    When I request "GET /null"
    Then I should receive status 500
    And the response should contain error "didn't return valid result"