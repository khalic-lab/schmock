Feature: Stateful Workflows E2E
  As a developer creating stateful applications
  I want to maintain consistent state across requests
  So that I can simulate real application behaviors

  Scenario: Shopping cart workflow
    Given I create a stateful shopping cart mock:
      """
      const mock = schmock({ state: { items: [], total: 0 } })
      mock('GET /cart', ({ state }) => ({
        items: state.items,
        total: state.total,
        count: state.items.length
      }))
      mock('POST /cart/add', ({ state, body }) => {
        const item = {
          id: Date.now(),
          name: body.name,
          price: body.price,
          quantity: body.quantity || 1
        }
        state.items.push(item)
        state.total += item.price * item.quantity
        return {
          message: 'Item added to cart',
          added: item,
          cart: {
            items: state.items,
            total: state.total,
            count: state.items.length
          }
        }
      })
      mock('DELETE /cart/:id', ({ state, params }) => {
        const itemId = parseInt(params.id)
        const itemIndex = state.items.findIndex(item => item.id === itemId)
        if (itemIndex === -1) {
          return [404, { error: 'Item not found in cart' }]
        }
        const removedItem = state.items[itemIndex]
        state.total -= removedItem.price * removedItem.quantity
        state.items.splice(itemIndex, 1)
        return {
          message: 'Item removed from cart',
          item: removedItem,
          cart: {
            items: state.items,
            total: state.total,
            count: state.items.length
          }
        }
      })
      mock('POST /cart/clear', ({ state }) => {
        state.items = []
        state.total = 0
        return {
          message: 'Cart cleared',
          cart: {
            items: state.items,
            total: state.total,
            count: state.items.length
          }
        }
      })
      """
    When I request "GET /cart"
    Then the response should show an empty cart with count 0
    When I add item with name "Apple" and price "1.50"
    And I add second item with name "Banana" and price "0.75"
    Then the cart should contain 2 items
    And the initial cart total should be "2.25"
    When I remove the first item from the cart
    Then the cart should contain 1 item
    And the final cart total should be "0.75"

  Scenario: User session simulation
    Given I create a session-based mock:
      """
      const mock = schmock({
        state: {
          users: [
            { username: 'admin', password: 'secret', profile: { name: 'Admin User', role: 'administrator' } },
            { username: 'user1', password: 'pass123', profile: { name: 'Regular User', role: 'user' } }
          ],
          sessions: {}
        }
      })
      mock('POST /auth/login', ({ state, body }) => {
        const user = state.users.find(u => u.username === body.username && u.password === body.password)
        if (!user) {
          return [401, { error: 'Invalid credentials' }]
        }
        const token = 'token-' + user.username + '-' + Date.now()
        state.sessions[token] = {
          user: user.username,
          profile: user.profile,
          loginTime: new Date().toISOString()
        }
        return {
          message: 'Login successful',
          token: token,
          user: user.profile
        }
      })
      mock('GET /profile', ({ state, headers }) => {
        const token = headers.authorization ? headers.authorization.replace('Bearer ', '') : ''
        if (!token || !state.sessions[token]) {
          return [401, { error: 'Unauthorized' }]
        }
        const session = state.sessions[token]
        return {
          user: session.user,
          profile: session.profile,
          loginTime: session.loginTime,
          session: {
            active: true
          }
        }
      })
      mock('POST /auth/logout', ({ state, headers }) => {
        const token = headers.authorization ? headers.authorization.replace('Bearer ', '') : ''
        if (!token || !state.sessions[token]) {
          return [401, { error: 'Unauthorized' }]
        }
        delete state.sessions[token]
        return { message: 'Logged out successfully' }
      })
      """
    When I login with username "admin" and password "secret"
    Then I should receive a session token
    And the response should contain user info with role "administrator"
    When I request "/profile" with the session token
    Then I should get my profile information
    And the session should be marked as active
    When I logout with the session token
    Then the logout should be successful
    When I request "/profile" with the same token
    Then I should get a 401 unauthorized response

  Scenario: Multi-user state isolation
    Given I create a multi-user counter mock:
      """
      const mock = schmock({ state: { counters: {} } })
      mock('POST /counter/:userId/increment', ({ state, params }) => {
        const userId = params.userId
        if (!state.counters[userId]) {
          state.counters[userId] = 0
        }
        state.counters[userId]++
        return {
          userId: userId,
          count: state.counters[userId],
          message: 'Counter incremented for user ' + userId
        }
      })
      mock('GET /counter/:userId', ({ state, params }) => {
        const userId = params.userId
        const count = state.counters[userId] || 0
        return {
          userId: userId,
          count: count
        }
      })
      mock('GET /counters/summary', ({ state }) => {
        const totalCount = Object.values(state.counters).reduce((sum, count) => sum + count, 0)
        const userCount = Object.keys(state.counters).length
        return {
          totalCounts: totalCount,
          totalUsers: userCount,
          counters: state.counters
        }
      })
      """
    When user "alice" increments their counter 3 times
    And user "bob" increments their counter 2 times
    Then "alice"'s counter should be 3
    And "bob"'s counter should be 2
    And the summary should show 2 total users
    And the summary should show total counts of 5
    And each user's state should be independent
