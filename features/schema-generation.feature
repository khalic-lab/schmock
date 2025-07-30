Feature: Schema-Based Data Generation
  As a developer
  I want to automatically generate realistic fake data from JSON schemas
  So that I can create mock APIs without manual data mapping

  # Core principle: Provide schema, get realistic data - zero configuration required
  # Override system allows customization when needed
  # Foundation for future business rules layer

  Scenario: Basic object generation from JSON schema
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/user': {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                email: { type: 'string', format: 'email' },
                active: { type: 'boolean' }
              },
              required: ['id', 'name', 'email']
            }
          }
        })
      """
    When I request "GET /api/user"
    Then the response should have:
      | field  | type    | format |
      | id     | number  |        |
      | name   | string  |        |
      | email  | string  | email  |
      | active | boolean |        |

  Scenario: Array generation with automatic count detection
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/users': {
            schema: {
              type: 'array',
              minItems: 2,
              maxItems: 5,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  name: { type: 'string' }
                }
              }
            }
          }
        })
      """
    When I request "GET /api/users"
    Then the response should be an array with 2-5 items
    And each item should have:
      | field | type   |
      | id    | number |
      | name  | string |

  Scenario: Smart field name inference
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/profile': {
            schema: {
              type: 'object',
              properties: {
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                phoneNumber: { type: 'string' },
                createdAt: { type: 'string', format: 'date-time' },
                uuid: { type: 'string', format: 'uuid' }
              }
            }
          }
        })
      """
    When I request "GET /api/profile"
    Then the response should contain realistic data:
      | field       | pattern                      |
      | firstName   | realistic first name         |
      | lastName    | realistic last name          |
      | phoneNumber | phone number format          |
      | createdAt   | valid ISO 8601 datetime      |
      | uuid        | valid UUID v4 format         |

  Scenario: Override specific fields
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/admin': {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                role: { type: 'string' },
                email: { type: 'string', format: 'email' }
              }
            },
            overrides: {
              role: 'admin',
              email: 'admin@company.com'
            }
          }
        })
      """
    When I request "GET /api/admin"  
    Then the response should have:
      | field | value             |
      | role  | admin             |
      | email | admin@company.com |
    And the id should be a generated integer

  Scenario: Template-based overrides with state integration
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .state({ currentUser: { id: 123, name: 'John' } })
        .routes({
          'GET /api/posts/:userId': {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  authorId: { type: 'integer' },
                  title: { type: 'string' },
                  content: { type: 'string' }
                }
              }
            },
            count: 3,
            overrides: {
              authorId: '{{ params.userId }}'
            }
          }
        })
      """
    When I request "GET /api/posts/456"
    Then the response should be an array with 3 items
    And each item should have authorId as 456

  Scenario: Array count override
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/products': {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  price: { type: 'number' }
                }
              }
            },
            count: 10
          }
        })
      """
    When I request "GET /api/products"
    Then the response should be an array with exactly 10 items

  Scenario: Integration with existing response function
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/mixed': {
            schema: {
              type: 'object',
              properties: {
                user: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    email: { type: 'string', format: 'email' }
                  }
                },
                timestamp: { type: 'string', format: 'date-time' }
              }
            },
            response: ({ generateFromSchema }) => {
              const generated = generateFromSchema();
              return {
                ...generated,
                customField: 'added by response function'
              };
            }
          }
        })
      """
    When I request "GET /api/mixed"
    Then the response should have generated user data
    And the response should have customField as "added by response function"

  Scenario: Error handling for invalid schema
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/invalid': {
            schema: {
              type: 'invalid-type'
            }
          }
        })
      """
    When I request "GET /api/invalid"
    Then the status should be 500
    And the response should contain error information

  Scenario: Nested object generation
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/company': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                address: {
                  type: 'object',
                  properties: {
                    street: { type: 'string' },
                    city: { type: 'string' },
                    zipCode: { type: 'string' }
                  }
                },
                employees: {
                  type: 'array',
                  maxItems: 3,
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      position: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        })
      """
    When I request "GET /api/company"
    Then the response should have nested address object
    And the response should have employees array with up to 3 items