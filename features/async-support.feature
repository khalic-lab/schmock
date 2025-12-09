Feature: Async Support
  As a developer using Schmock
  I want full support for async/Promise-based operations
  So that I can create realistic mocks for async APIs and workflows

  Scenario: Async generator function returns Promise
    Given I create a mock with async generator:
      """
      const mock = schmock()
      mock('GET /async-data', async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        return { message: 'async response' }
      })
      """
    When I request "GET /async-data"
    Then I should receive:
      """
      { "message": "async response" }
      """
    And the content-type should be "application/json"

  Scenario: Async generator with context access
    Given I create a mock with async context generator:
      """
      const mock = schmock()
      mock('GET /async-user/:id', async ({ params }) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return { 
          userId: params.id, 
          fetchedAt: new Date().toISOString()
        }
      })
      """
    When I request "GET /async-user/123"
    Then the response should have property "userId" with value "123"
    And the response should have property "fetchedAt"

  Scenario: Multiple async generators in different routes
    Given I create a mock with multiple async routes:
      """
      const mock = schmock()
      mock('GET /async-posts', async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return [{ id: 1, title: 'First Post' }]
      })
      mock('GET /async-comments', async () => {
        await new Promise(resolve => setTimeout(resolve, 8))
        return [{ id: 1, comment: 'Great post!' }]
      })
      """
    When I make concurrent requests to "/async-posts" and "/async-comments"
    Then both responses should be returned successfully
    And the posts response should contain "First Post"
    And the comments response should contain "Great post!"

  Scenario: Async plugin processing
    Given I create a mock with async plugin:
      """
      const mock = schmock()
      const asyncPlugin = {
        name: 'async-processor',
        process: async (ctx, response) => {
          await new Promise(resolve => setTimeout(resolve, 5))
          return {
            context: ctx,
            response: {
              data: response,
              processedAsync: true,
              timestamp: new Date().toISOString()
            }
          }
        }
      }
      mock('GET /processed', { original: 'data' }).pipe(asyncPlugin)
      """
    When I request "GET /processed"
    Then the async response should have property "data"
    And the async response should have property "processedAsync" with value true
    And the async response should have property "timestamp"

  Scenario: Mixed sync and async plugin pipeline
    Given I create a mock with mixed plugin pipeline:
      """
      const mock = schmock()
      const syncPlugin = {
        name: 'sync-step',
        process: (ctx, response) => ({
          context: ctx,
          response: { ...response, syncStep: true }
        })
      }
      const asyncPlugin = {
        name: 'async-step',
        process: async (ctx, response) => {
          await new Promise(resolve => setTimeout(resolve, 5))
          return {
            context: ctx,
            response: { ...response, asyncStep: true }
          }
        }
      }
      mock('GET /mixed', { base: 'data' })
        .pipe(syncPlugin)
        .pipe(asyncPlugin)
      """
    When I request "GET /mixed"
    Then the response should have property "base" with value "data"
    And the response should have property "syncStep" with value true
    And the response should have property "asyncStep" with boolean value true

  Scenario: Async generator with Promise rejection
    Given I create a mock with failing async generator:
      """
      const mock = schmock()
      mock('GET /async-fail', async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        throw new Error('Async operation failed')
      })
      """
    When I request "GET /async-fail"
    Then I should receive status 500
    And the response should contain error "Async operation failed"

  Scenario: Async plugin error recovery
    Given I create a mock with async error recovery:
      """
      const mock = schmock()
      const asyncErrorPlugin = {
        name: 'async-error-handler',
        process: async () => {
          await new Promise(resolve => setTimeout(resolve, 5))
          throw new Error('Async plugin failed')
        },
        onError: async (error, ctx) => {
          await new Promise(resolve => setTimeout(resolve, 3))
          return {
            status: 200,
            body: { recovered: true, originalError: error.message },
            headers: {}
          }
        }
      }
      mock('GET /async-recovery', 'original').pipe(asyncErrorPlugin)
      """
    When I request "GET /async-recovery"
    Then I should receive status 200
    And the response should have property "recovered" with value true
    And the response should have property "originalError"

  Scenario: Async generator with delay configuration
    Given I create a mock with async generator and delay:
      """
      const mock = schmock({ delay: 20 })
      mock('GET /delayed-async', async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        return { delayed: true, async: true }
      })
      """
    When I request "GET /delayed-async" and measure time
    Then the response time should be at least 30ms
    And I should receive:
      """
      { "delayed": true, "async": true }
      """

  Scenario: Async generator with state management
    Given I create a mock with async stateful generator:
      """
      const mock = schmock({ state: { asyncCounter: 0 } })
      mock('GET /async-counter', async ({ state }) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        state.asyncCounter = (state.asyncCounter || 0) + 1
        return { 
          count: state.asyncCounter,
          processedAsync: true
        }
      })
      """
    When I request "GET /async-counter" twice
    Then the first response should have count 1
    And the second response should have count 2
    And both responses should have processedAsync true

  Scenario: Promise-based plugin response generation
    Given I create a mock with Promise-generating plugin:
      """
      const mock = schmock()
      const promisePlugin = {
        name: 'promise-generator',
        process: async (ctx, response) => {
          if (!response) {
            const data = await Promise.resolve({ generated: 'by promise' })
            return { context: ctx, response: data }
          }
          return { context: ctx, response }
        }
      }
      mock('GET /promise-gen', null).pipe(promisePlugin)
      """
    When I request "GET /promise-gen"
    Then I should receive:
      """
      { "generated": "by promise" }
      """

  Scenario: Concurrent async requests isolation
    Given I create a mock with async state isolation:
      """
      const mock = schmock()
      mock('GET /isolated/:id', async ({ params }) => {
        const delay = parseInt(params.id) * 5
        await new Promise(resolve => setTimeout(resolve, delay))
        return { 
          id: params.id,
          processedAt: Date.now()
        }
      })
      """
    When I make concurrent requests to "/isolated/1", "/isolated/2", and "/isolated/3"
    Then all responses should have different processedAt timestamps
    And each response should have the correct id value
    And the responses should complete in expected order

  Scenario: Async plugin pipeline with context state
    Given I create a mock with async stateful plugins:
      """
      const mock = schmock()
      const plugin1 = {
        name: 'async-step-1',
        process: async (ctx, response) => {
          await new Promise(resolve => setTimeout(resolve, 5))
          ctx.state.set('step1', 'completed')
          return { context: ctx, response }
        }
      }
      const plugin2 = {
        name: 'async-step-2',
        process: async (ctx, response) => {
          await new Promise(resolve => setTimeout(resolve, 3))
          const step1Status = ctx.state.get('step1')
          return {
            context: ctx,
            response: {
              ...response,
              step1: step1Status,
              step2: 'completed'
            }
          }
        }
      }
      mock('GET /async-pipeline', { base: 'data' })
        .pipe(plugin1)
        .pipe(plugin2)
      """
    When I request "GET /async-pipeline"
    Then the response should have property "base" with value "data"
    And the async pipeline response should have both step properties completed