Feature: Stateful Workflows E2E
  As a developer creating stateful applications
  I want to maintain consistent state across requests
  So that I can simulate real application behaviors

  Scenario: Shopping cart workflow
    Given I create a stateful shopping cart mock:
      """
      schmock()
        .state({ items: [], total: 0 })
        .routes({
          'GET /cart': {
            response: ({ state }) => ({
              items: state.items,
              total: state.total,
              count: state.items.length
            })
          },
          'POST /cart/add': {
            response: ({ state, body }) => {
              const item = { id: Date.now(), ...body };
              state.items.push(item);
              state.total += item.price || 0;
              return [201, { added: item, cartTotal: state.total }];
            }
          },
          'DELETE /cart/:id': {
            response: ({ state, params }) => {
              const itemId = parseInt(params.id);
              const itemIndex = state.items.findIndex(item => item.id === itemId);
              if (itemIndex === -1) {
                return [404, { error: 'Item not found' }];
              }
              const removedItem = state.items.splice(itemIndex, 1)[0];
              state.total -= removedItem.price || 0;
              return { removed: removedItem, cartTotal: state.total };
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
      schmock()
        .state({ users: {}, sessions: {} })
        .routes({
          'POST /auth/login': {
            response: ({ state, body }) => {
              const { username, password } = body;
              if (username === 'admin' && password === 'secret') {
                const sessionId = Math.random().toString(36);
                const user = { id: 1, username: 'admin', role: 'administrator' };
                state.users[sessionId] = user;
                state.sessions[sessionId] = { createdAt: Date.now(), active: true };
                return { token: sessionId, user };
              }
              return [401, { error: 'Invalid credentials' }];
            }
          },
          'GET /profile': {
            response: ({ state, headers }) => {
              const token = headers.authorization?.replace('Bearer ', '');
              const user = state.users[token];
              const session = state.sessions[token];
              
              if (!user || !session?.active) {
                return [401, { error: 'Unauthorized' }];
              }
              
              return { 
                user,
                session: { active: session.active, createdAt: session.createdAt }
              };
            }
          },
          'POST /auth/logout': {
            response: ({ state, headers }) => {
              const token = headers.authorization?.replace('Bearer ', '');
              if (state.sessions[token]) {
                state.sessions[token].active = false;
                delete state.users[token];
              }
              return { message: 'Logged out successfully' };
            }
          }
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
      schmock()
        .state({ userCounters: {} })
        .routes({
          'POST /counter/:userId/increment': {
            response: ({ state, params }) => {
              const userId = params.userId;
              state.userCounters[userId] = (state.userCounters[userId] || 0) + 1;
              return { 
                userId,
                count: state.userCounters[userId],
                totalUsers: Object.keys(state.userCounters).length
              };
            }
          },
          'GET /counter/:userId': {
            response: ({ state, params }) => {
              const userId = params.userId;
              return {
                userId,
                count: state.userCounters[userId] || 0
              };
            }
          },
          'GET /counters/summary': {
            response: ({ state }) => ({
              users: state.userCounters,
              totalUsers: Object.keys(state.userCounters).length,
              totalCounts: Object.values(state.userCounters).reduce((a, b) => a + b, 0)
            })
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