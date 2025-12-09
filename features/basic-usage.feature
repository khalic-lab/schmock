Feature: Basic Usage
  As a new developer
  I want to create simple mocks with minimal code
  So that I can get started quickly without reading documentation

  # These are the MOST BASIC scenarios that every developer will try first
  # If these don't work intuitively, we've failed at DX

  Scenario: Simplest possible mock - plain text
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /', 'Hello World')
      """
    When I request "GET /"
    Then I should receive text "Hello World"
    And the content-type should be "text/plain"

  Scenario: Return JSON without specifying contentType
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /users', [{ id: 1, name: 'John' }])
      """
    When I request "GET /users"
    Then I should receive:
      """
      [{ "id": 1, "name": "John" }]
      """
    And the content-type should be "application/json"

  Scenario: Return object without contentType
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /user', { id: 1, name: 'John' })
      """
    When I request "GET /user"
    Then I should receive:
      """
      { "id": 1, "name": "John" }
      """
    And the content-type should be "application/json"

  Scenario: Empty mock instance
    Given I create a mock with:
      """
      const mock = schmock()
      """
    When I request "GET /anything"
    Then the status should be 404

  Scenario: Null response
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /null', null)
      """
    When I request "GET /null"
    Then I should receive empty response
    And the status should be 204

  Scenario: Undefined response
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /undefined', undefined)
      """
    When I request "GET /undefined"
    Then I should receive empty response
    And the status should be 204

  Scenario: Empty string response
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /empty', '')
      """
    When I request "GET /empty"
    Then I should receive text ""
    And the content-type should be "text/plain"

  Scenario: Number response
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /count', 42)
      """
    When I request "GET /count"
    Then I should receive text "42"
    And the content-type should be "text/plain"

  Scenario: Boolean response
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /active', true)
      """
    When I request "GET /active"
    Then I should receive text "true"
    And the content-type should be "text/plain"

  Scenario: Function returning string
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /dynamic', () => 'Dynamic response')
      """
    When I request "GET /dynamic"
    Then I should receive text "Dynamic response"

  Scenario: Function returning object
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /dynamic-json', () => ({ timestamp: Date.now() }))
      """
    When I request "GET /dynamic-json"
    Then the response should be valid JSON
    And the response should have property "timestamp"

  Scenario: Multiple routes
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /', 'Home')
      mock('GET /about', 'About Us')
      mock('GET /contact', { email: 'test@example.com' })
      """
    When I make three requests to different routes
    Then the home route should return "Home"
    And the about route should return "About Us"
    And the contact route should return:
      """
      { "email": "test@example.com" }
      """

  Scenario: Override contentType detection
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /data', { foo: 'bar' }, { contentType: 'text/plain' })
      """
    When I request "GET /data"
    Then I should receive text '{"foo":"bar"}'
    And the content-type should be "text/plain"

  Scenario: HTML response
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /page', '<h1>Hello</h1>', { contentType: 'text/html' })
      """
    When I request "GET /page"
    Then I should receive text "<h1>Hello</h1>"
    And the content-type should be "text/html"

  Scenario: Binary/buffer response detection
    Given I create a mock with:
      """
      const mock = schmock()
      mock('GET /binary', Buffer.from('binary data'))
      """
    When I request "GET /binary"
    Then I should receive buffer data
    And the content-type should be "application/octet-stream"