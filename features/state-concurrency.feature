Feature: State Management and Concurrency
  As a developer using Schmock
  I want reliable state management under concurrent access
  So that my stateful mocks behave predictably in multi-threaded scenarios

  Scenario: Concurrent state updates with race conditions
    Given I create a mock with shared counter state:
      """
      const mock = schmock({ state: { counter: 0 } })
      mock('POST /increment', ({ state }) => {
        const current = state.counter
        // Simulate some processing time that could cause race conditions
        state.counter = current + 1
        return { counter: state.counter, previous: current }
      })
      """
    When I make 5 concurrent increment requests
    Then all requests should complete successfully
    And the final counter should reflect all increments
    And each response should show sequential progression

  Scenario: Concurrent access to different state properties
    Given I create a mock with multiple state properties:
      """
      const mock = schmock({ 
        state: { 
          users: 0, 
          posts: 0, 
          comments: 0 
        } 
      })
      mock('POST /users', ({ state }) => {
        state.users++
        return { type: 'user', count: state.users }
      })
      mock('POST /posts', ({ state }) => {
        state.posts++
        return { type: 'post', count: state.posts }
      })
      mock('POST /comments', ({ state }) => {
        state.comments++
        return { type: 'comment', count: state.comments }
      })
      """
    When I make concurrent requests to different endpoints
    Then each endpoint should maintain its own counter correctly
    And the final state should show accurate counts for all properties

  Scenario: State isolation between different mock instances
    Given I create two separate mock instances with state:
      """
      const mock1 = schmock({ state: { value: 10 } })
      const mock2 = schmock({ state: { value: 20 } })
      
      mock1('GET /value', ({ state }) => ({ instance: 1, value: state.value }))
      mock2('GET /value', ({ state }) => ({ instance: 2, value: state.value }))
      
      mock1('POST /update', ({ state, body }) => {
        state.value = body.newValue
        return { instance: 1, updated: state.value }
      })
      mock2('POST /update', ({ state, body }) => {
        state.value = body.newValue
        return { instance: 2, updated: state.value }
      })
      """
    When I update state in both mock instances concurrently
    Then each mock instance should maintain its own isolated state
    And changes in one instance should not affect the other

  Scenario: Concurrent plugin state modifications
    Given I create a mock with stateful plugins:
      """
      const mock = schmock({ state: { requestCount: 0, pluginData: {} } })
      
      const plugin1 = {
        name: 'counter-plugin',
        process: (ctx, response) => {
          ctx.state.requestCount++
          ctx.state.pluginData.plugin1 = (ctx.state.pluginData.plugin1 || 0) + 1
          return {
            context: ctx,
            response: { ...response, plugin1Count: ctx.state.pluginData.plugin1 }
          }
        }
      }
      
      const plugin2 = {
        name: 'tracker-plugin', 
        process: (ctx, response) => {
          ctx.state.pluginData.plugin2 = (ctx.state.pluginData.plugin2 || 0) + 1
          return {
            context: ctx,
            response: { ...response, plugin2Count: ctx.state.pluginData.plugin2 }
          }
        }
      }
      
      mock('GET /data', { base: 'data' }).pipe(plugin1).pipe(plugin2)
      """
    When I make concurrent requests through the plugin pipeline
    Then each plugin should correctly update its state counters
    And the global request count should be accurate
    And plugin state should not interfere with each other

  Scenario: State persistence across request contexts
    Given I create a mock with persistent session state:
      """
      const mock = schmock({ 
        state: { 
          sessions: {},
          activeUsers: 0
        } 
      })
      
      mock('POST /login', ({ state, body }) => {
        const sessionId = 'session_' + Date.now()
        state.sessions[sessionId] = { 
          user: body.username, 
          loginTime: new Date().toISOString() 
        }
        state.activeUsers++
        return { sessionId, message: 'Logged in', activeUsers: state.activeUsers }
      })
      
      mock('GET /sessions/:sessionId', ({ state, params }) => {
        const session = state.sessions[params.sessionId]
        return session ? { session, totalSessions: Object.keys(state.sessions).length } 
                       : [404, { error: 'Session not found' }]
      })
      
      mock('DELETE /sessions/:sessionId', ({ state, params }) => {
        if (state.sessions[params.sessionId]) {
          delete state.sessions[params.sessionId]
          state.activeUsers--
          return { message: 'Logged out', activeUsers: state.activeUsers }
        }
        return [404, { error: 'Session not found' }]
      })
      """
    When I simulate concurrent user login and logout operations
    Then session state should be maintained correctly across requests
    And active user count should remain consistent
    And session cleanup should work properly

  Scenario: Large state object concurrent modifications
    Given I create a mock with large state object:
      """
      const mock = schmock({ 
        state: { 
          data: Array.from({ length: 1000 }, (_, i) => ({ id: i, value: 0 }))
        } 
      })
      
      mock('PATCH /data/:id', ({ state, params, body }) => {
        const id = parseInt(params.id)
        const item = state.data.find(d => d.id === id)
        if (item) {
          item.value = body.value
          return { id, updated: item.value, total: state.data.length }
        }
        return [404, { error: 'Item not found' }]
      })
      
      mock('GET /data/stats', ({ state }) => {
        const total = state.data.reduce((sum, item) => sum + item.value, 0)
        const average = total / state.data.length
        return { total, average, items: state.data.length }
      })
      """
    When I make concurrent updates to different parts of large state
    Then all updates should be applied correctly
    And statistics should reflect the correct aggregated values
    And no data corruption should occur

  Scenario: State cleanup and memory management
    Given I create a mock with temporary state management:
      """
      const mock = schmock({ 
        state: { 
          cache: {},
          cacheSize: 0,
          maxCacheSize: 5
        } 
      })
      
      mock('POST /cache/:key', ({ state, params, body }) => {
        // Simple LRU-like cache with size limit
        if (state.cacheSize >= state.maxCacheSize) {
          const oldestKey = Object.keys(state.cache)[0]
          delete state.cache[oldestKey]
          state.cacheSize--
        }
        
        state.cache[params.key] = {
          value: body.value,
          timestamp: Date.now()
        }
        state.cacheSize++
        
        return { 
          key: params.key, 
          cached: true, 
          cacheSize: state.cacheSize 
        }
      })
      
      mock('GET /cache/:key', ({ state, params }) => {
        const item = state.cache[params.key]
        return item ? { key: params.key, ...item } 
                    : [404, { error: 'Not found in cache' }]
      })
      """
    When I add items to cache beyond the size limit concurrently
    Then the cache should maintain its size limit
    And old items should be evicted properly
    And cache size should remain consistent

  Scenario: Nested state object concurrent access
    Given I create a mock with deeply nested state:
      """
      const mock = schmock({ 
        state: { 
          users: {
            profiles: {},
            preferences: {},
            activity: {}
          }
        } 
      })
      
      mock('PUT /users/:id/profile', ({ state, params, body }) => {
        if (!state.users.profiles[params.id]) {
          state.users.profiles[params.id] = {}
        }
        Object.assign(state.users.profiles[params.id], body)
        return { userId: params.id, profile: state.users.profiles[params.id] }
      })
      
      mock('PUT /users/:id/preferences', ({ state, params, body }) => {
        state.users.preferences[params.id] = { ...body, updatedAt: Date.now() }
        return { userId: params.id, preferences: state.users.preferences[params.id] }
      })
      
      mock('POST /users/:id/activity', ({ state, params, body }) => {
        if (!state.users.activity[params.id]) {
          state.users.activity[params.id] = []
        }
        state.users.activity[params.id].push({ ...body, timestamp: Date.now() })
        return { 
          userId: params.id, 
          activityCount: state.users.activity[params.id].length 
        }
      })
      """
    When I make concurrent updates to different nested state sections
    Then each nested section should be updated independently
    And no cross-contamination should occur between user data
    And nested state structure should remain intact

  Scenario: State rollback on plugin errors
    Given I create a mock with error-prone stateful plugin:
      """
      const mock = schmock({ state: { transactions: [], balance: 100 } })
      
      const transactionPlugin = {
        name: 'transaction-plugin',
        process: (ctx, response) => {
          const amount = ctx.body.amount
          const currentBalance = ctx.state.balance
          
          // Simulate transaction processing
          if (amount > currentBalance) {
            throw new Error('Insufficient funds')
          }
          
          ctx.state.balance -= amount
          ctx.state.transactions.push({
            amount,
            balanceAfter: ctx.state.balance,
            timestamp: Date.now()
          })
          
          return {
            context: ctx,
            response: {
              success: true,
              newBalance: ctx.state.balance,
              transactionCount: ctx.state.transactions.length
            }
          }
        },
        onError: (error, ctx) => {
          // Don't modify state on error - let it rollback naturally
          return {
            status: 400,
            body: { error: error.message, balance: ctx.state.balance },
            headers: {}
          }
        }
      }
      
      mock('POST /transaction', { initialBalance: 100 }).pipe(transactionPlugin)
      """
    When I make concurrent transactions including some that should fail
    Then successful transactions should update state correctly
    And failed transactions should not modify state
    And final balance should reflect only successful transactions
    And transaction history should be consistent

  Scenario: Atomic state updates with AsyncMutex
    Given I create a mock with AsyncMutex:
      """
      const mutex = createMutex()
      const mock = schmock({ state: { counter: 0 } })
      mock('POST /increment', async ({ state }) => {
        return await mutex.run(async () => {
          const current = state.counter
          // Simulate async operation
          await new Promise(r => setTimeout(r, 10))
          state.counter = current + 1
          return { counter: state.counter }
        })
      })
      """
    When I make 10 concurrent increment requests
    Then the final counter should be 10
    And all responses should have sequential counter values