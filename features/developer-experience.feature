Feature: Developer Experience
  As a developer new to Schmock
  I want clear error messages and intuitive behavior
  So that I can quickly understand and fix common mistakes

  Scenario: Forgetting to provide response data
    Given I create a mock without response data:
      """
      const mock = schmock()
      mock('GET /empty')
      """
    When I request "GET /empty"
    Then I should receive status 204
    And the response body should be empty

  Scenario: Using wrong parameter name in route
    Given I create a mock with parameter route:
      """
      const mock = schmock()
      mock('GET /users/:userId', ({ params }) => ({ id: params.id }))
      """
    When I request "GET /users/123"
    Then the wrong parameter should be undefined

  Scenario: Correct parameter usage
    Given I create a mock with proper parameter usage:
      """
      const mock = schmock()
      mock('GET /users/:userId', ({ params }) => ({ id: params.userId }))
      """
    When I request "GET /users/123"
    Then I should receive:
      """
      { "id": "123" }
      """

  Scenario: Mixing content types without explicit configuration
    Given I create a mock with mixed content types:
      """
      const mock = schmock()
      mock('GET /json', { data: 'json' })
      mock('GET /text', 'plain text')
      mock('GET /number', 42)
      mock('GET /boolean', true)
      """
    When I test all mixed content type routes
    Then JSON route should have content-type "application/json"
    And text route should have content-type "text/plain"
    And number route should have content-type "text/plain"
    And boolean route should have content-type "text/plain"

  Scenario: Expecting JSON but getting string conversion
    Given I create a mock with number response:
      """
      const mock = schmock()
      mock('GET /price', 19.99)
      """
    When I request "GET /price"
    Then I should receive text "19.99"
    And the content-type should be "text/plain"

  Scenario: Forgetting await with async generators
    Given I create a mock with async generator:
      """
      const mock = schmock()
      mock('GET /data', async () => ({ async: true }))
      """
    When I request "GET /data"
    Then I should receive:
      """
      { "async": true }
      """
    And the content-type should be "application/json"

  Scenario: State confusion between global and local state
    Given I create a mock with state confusion:
      """
      const mock = schmock({ state: { global: 1 } })
      mock('GET /counter', ({ state }) => {
        state.local = (state.local || 0) + 1
        return { global: state.global, local: state.local }
      })
      """
    When I request "GET /counter" twice
    Then the first response should have:
      """
      { "global": 1, "local": 1 }
      """
    And the second response should have:
      """
      { "global": 1, "local": 2 }
      """

  Scenario: Query parameter edge cases
    Given I create a mock handling query parameters:
      """
      const mock = schmock()
      mock('GET /search', ({ query }) => ({ 
        term: query.q,
        page: query.page,
        empty: query.empty
      }))
      """
    When I request "GET /search?q=test&page=&empty"
    Then I should receive:
      """
      { "term": "test", "page": "", "empty": "" }
      """

  Scenario: Headers case sensitivity
    Given I create a mock checking headers:
      """
      const mock = schmock()
      mock('GET /auth', ({ headers }) => ({ 
        auth: headers.authorization,
        authUpper: headers.Authorization,
        contentType: headers['content-type']
      }))
      """
    When I request "GET /auth" with headers:
      """
      { "Authorization": "Bearer token", "Content-Type": "application/json" }
      """
    Then the header case sensitivity should show expected values

  Scenario: Route precedence with similar paths
    Given I create a mock with similar routes:
      """
      const mock = schmock()
      mock('GET /users/profile', { type: 'profile' })
      mock('GET /users/:id', ({ params }) => ({ type: 'user', id: params.id }))
      """
    When I test both route precedence scenarios
    Then the profile route should return exact match:
      """
      { "type": "profile" }
      """
    And the parameterized route should match with param:
      """
      { "type": "user", "id": "123" }
      """

  Scenario: Plugin order affecting results
    Given I create a mock with order-dependent plugins:
      """
      const mock = schmock()
      const plugin1 = {
        name: 'first',
        process: (ctx, response) => ({
          context: ctx,
          response: { ...response, step: 1 }
        })
      }
      const plugin2 = {
        name: 'second', 
        process: (ctx, response) => ({
          context: ctx,
          response: { ...response, step: 2 }
        })
      }
      mock('GET /order', { original: true })
        .pipe(plugin1)
        .pipe(plugin2)
      """
    When I request "GET /order"
    Then I should receive:
      """
      { "original": true, "step": 2 }
      """

  Scenario: Namespace confusion with absolute paths
    Given I create a mock with namespace:
      """
      const mock = schmock({ namespace: '/api/v1' })
      mock('GET /users', [])
      """
    When I test both namespace scenarios
    Then the wrong namespace should receive status 404
    And the correct namespace should receive:
      """
      []
      """

  Scenario: Plugin expecting different context structure
    Given I create a mock with context-dependent plugin:
      """
      const mock = schmock()
      const plugin = {
        name: 'context-reader',
        process: (ctx, response) => ({
          context: ctx,
          response: {
            method: ctx.method,
            path: ctx.path,
            hasBody: !!ctx.body,
            hasQuery: !!ctx.query && Object.keys(ctx.query).length > 0
          }
        })
      }
      mock('POST /analyze', null).pipe(plugin)
      """
    When I request "POST /analyze?test=1" with body:
      """
      { "data": "test" }
      """
    Then I should receive:
      """
      { "method": "POST", "path": "/analyze", "hasBody": true, "hasQuery": true }
      """

  Scenario: Response tuple format edge cases
    Given I create a mock with tuple responses:
      """
      const mock = schmock()
      mock('GET /created', [201])
      mock('GET /with-headers', [200, { data: true }, { 'x-custom': 'header' }])
      mock('GET /empty-with-status', [204, null])
      """
    When I test all tuple response formats
    Then the created endpoint should return status 201 with empty body
    And the headers endpoint should return status 200 with data and custom header
    And the empty endpoint should return status 204 with null body

  Scenario: Common typos in method names
    Given I attempt to create mocks with typo methods:
      """
      const mock = schmock()
      // These should fail with clear error messages
      """
    When I test all common method typos
    Then the wrong method typo should throw RouteParseError
    And the lowercase method typo should throw RouteParseError
    And the missing space typo should throw RouteParseError

  Scenario: Plugin returning unexpected structure
    Given I create a mock with malformed plugin:
      """
      const mock = schmock()
      const badPlugin = {
        name: 'bad-structure',
        process: () => ({ wrong: 'structure' })
      }
      mock('GET /bad', 'original').pipe(badPlugin)
      """
    When I request "GET /bad"
    Then I should receive status 500
    And the response should contain error "didn't return valid result"