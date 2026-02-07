Feature: HTTP Methods Support
  As a developer using Schmock
  I want comprehensive support for all HTTP methods
  So that I can mock any REST API endpoint accurately

  Scenario: GET method with query parameters
    Given I create a mock with GET endpoint:
      """
      const mock = schmock()
      mock('GET /search', ({ query }) => ({
        results: [],
        query: query.q,
        page: parseInt(query.page || '1'),
        limit: parseInt(query.limit || '10')
      }))
      """
    When I make a GET request to "/search?q=test&page=2&limit=5"
    Then I should receive GET method response:
      """
      { "results": [], "query": "test", "page": 2, "limit": 5 }
      """

  Scenario: POST method with JSON body
    Given I create a mock with POST endpoint:
      """
      const mock = schmock()
      mock('POST /users', ({ body }) => [201, {
        id: 123,
        ...body,
        createdAt: '2023-01-01T00:00:00Z'
      }])
      """
    When I make a POST request to "/users" with JSON body:
      """
      { "name": "John Doe", "email": "john@example.com" }
      """
    Then I should receive status 201
    And I should receive POST method response:
      """
      { "id": 123, "name": "John Doe", "email": "john@example.com", "createdAt": "2023-01-01T00:00:00Z" }
      """

  Scenario: PUT method for resource updates
    Given I create a mock with PUT endpoint:
      """
      const mock = schmock()
      mock('PUT /users/:id', ({ params, body }) => ({
        id: parseInt(params.id),
        ...body,
        updatedAt: '2023-01-01T00:00:00Z'
      }))
      """
    When I make a PUT request to "/users/456" with JSON body:
      """
      { "name": "Jane Smith", "email": "jane@example.com" }
      """
    Then I should receive PUT method response:
      """
      { "id": 456, "name": "Jane Smith", "email": "jane@example.com", "updatedAt": "2023-01-01T00:00:00Z" }
      """

  Scenario: DELETE method with confirmation
    Given I create a mock with DELETE endpoint:
      """
      const mock = schmock()
      mock('DELETE /users/:id', ({ params }) => [204, null])
      """
    When I make a DELETE request to "/users/789"
    Then I should receive status 204
    And the DELETE response body should be empty

  Scenario: PATCH method for partial updates
    Given I create a mock with PATCH endpoint:
      """
      const mock = schmock()
      mock('PATCH /users/:id', ({ params, body }) => ({
        id: parseInt(params.id),
        email: 'existing@example.com', // Existing data
        ...body, // Partial update
        updatedAt: '2023-01-01T00:00:00Z'
      }))
      """
    When I make a PATCH request to "/users/321" with JSON body:
      """
      { "name": "Updated Name" }
      """
    Then I should receive PATCH method response:
      """
      { "id": 321, "email": "existing@example.com", "name": "Updated Name", "updatedAt": "2023-01-01T00:00:00Z" }
      """

  Scenario: HEAD method returns headers only
    Given I create a mock with HEAD endpoint:
      """
      const mock = schmock()
      mock('HEAD /users/:id', ({ params }) => [200, null, {
        'Content-Type': 'application/json',
        'Last-Modified': 'Wed, 01 Jan 2023 00:00:00 GMT',
        'Content-Length': '156'
      }])
      """
    When I make a HEAD request to "/users/111"
    Then I should receive status 200
    And the HEAD response body should be empty
    And the HEAD response should have proper headers set

  Scenario: OPTIONS method for CORS preflight
    Given I create a mock with OPTIONS endpoint:
      """
      const mock = schmock()
      mock('OPTIONS /api/users', () => [200, null, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }])
      """
    When I make an OPTIONS request to "/api/users"
    Then I should receive status 200
    And the OPTIONS response body should be empty
    And the OPTIONS response should have header "Access-Control-Allow-Methods" with value "GET, POST, PUT, DELETE, PATCH, OPTIONS"

  Scenario: Multiple methods on same path
    Given I create a mock with multiple methods on same path:
      """
      const mock = schmock()
      mock('GET /resource', { action: 'read' })
      mock('POST /resource', { action: 'create' })
      mock('PUT /resource', { action: 'update' })
      mock('DELETE /resource', { action: 'delete' })
      """
    When I test all methods on "/resource"
    Then the GET method should return:
      """
      { "action": "read" }
      """
    And the POST method should return:
      """
      { "action": "create" }
      """
    And the PUT method should return:
      """
      { "action": "update" }
      """
    And the DELETE method should return:
      """
      { "action": "delete" }
      """

  Scenario: Method-specific content types
    Given I create a mock with method-specific content types:
      """
      const mock = schmock()
      mock('GET /data.json', { data: 'json' })
      mock('GET /data.xml', '<data>xml</data>', { contentType: 'application/xml' })
      mock('GET /data.txt', 'plain text data')
      mock('POST /upload', 'File uploaded successfully', { contentType: 'text/plain' })
      """
    When I test method-specific content types
    Then the JSON endpoint should have content-type "application/json"
    And the XML endpoint should have content-type "application/xml"
    And the text endpoint should have content-type "text/plain"
    And the upload endpoint should have content-type "text/plain"

  Scenario: Method case sensitivity
    Given I create a mock with lowercase method:
      """
      const mock = schmock()
      """
    When I attempt to create a mock with lowercase method
    Then it should throw RouteParseError for invalid method case

  Scenario: Unsupported HTTP methods
    Given I create a mock with custom method:
      """
      const mock = schmock()
      """
    When I attempt to create a mock with unsupported method
    Then it should throw RouteParseError for unsupported method

  Scenario: Method with special characters in path
    Given I create a mock with special characters:
      """
      const mock = schmock()
      mock('GET /api/v1/users/:id/posts/:post-id', ({ params }) => ({
        userId: params.id,
        postId: params['post-id']
      }))
      """
    When I make a GET request to "/api/v1/users/123/posts/abc-def"
    Then I should receive special characters response:
      """
      { "userId": "123", "postId": "abc-def" }
      """

  Scenario: Method with request headers validation
    Given I create a mock with header validation:
      """
      const mock = schmock()
      mock('POST /secure', ({ headers, body }) => {
        if (headers.authorization !== 'Bearer valid-token') {
          return [401, { error: 'Unauthorized' }]
        }
        return [200, { message: 'Success', data: body }]
      })
      """
    When I make a POST request with valid headers
    Then I should receive authorized response:
      """
      { "message": "Success", "data": { "test": true } }
      """
    When I make a POST request with invalid headers
    Then I should receive status 401
    And I should receive unauthorized response:
      """
      { "error": "Unauthorized" }
      """

  Scenario: Method chaining with plugins
    Given I create a mock with method-specific plugins:
      """
      const mock = schmock()
      const loggerPlugin = {
        name: 'method-logger',
        process: (ctx, response) => ({
          context: ctx,
          response: {
            ...response,
            method: ctx.method,
            logged: true
          }
        })
      }
      mock('GET /logged', { data: 'get' }).pipe(loggerPlugin)
      mock('POST /logged', { data: 'post' }).pipe(loggerPlugin)
      """
    When I test method chaining with plugins
    Then the GET with plugin should return:
      """
      { "data": "get", "method": "GET", "logged": true }
      """
    And the POST with plugin should return:
      """
      { "data": "post", "method": "POST", "logged": true }
      """