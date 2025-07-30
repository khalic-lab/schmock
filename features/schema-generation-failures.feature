Feature: Schema Generation Failure Scenarios
  As a developer
  I want robust error handling for schema generation
  So that I get clear feedback when things go wrong

  # Testing edge cases, invalid inputs, and failure modes
  # Ensures the system fails gracefully with helpful error messages

  Scenario: Invalid JSON schema type
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/invalid': {
            schema: {
              type: 'unknown-type'
            }
          }
        })
      """
    When I request "GET /api/invalid"
    Then the status should be 500
    And the response should contain error information about invalid schema type

  Scenario: Malformed JSON schema structure
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/malformed': {
            schema: {
              type: 'object',
              properties: 'invalid-properties-format'
            }
          }
        })
      """
    When I request "GET /api/malformed"
    Then the status should be 500
    And the response should contain error information about malformed schema

  Scenario: Circular reference in schema
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/circular': {
            schema: {
              type: 'object',
              properties: {
                self: { $ref: '#' }
              }
            }
          }
        })
      """
    When I request "GET /api/circular"
    Then the status should be 500
    And the response should contain error information about circular reference

  Scenario: Invalid template syntax in overrides
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/bad-template': {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                value: { type: 'string' }
              }
            },
            overrides: {
              value: '{{ invalid.template.syntax.missing.close'
            }
          }
        })
      """
    When I request "GET /api/bad-template"
    Then the status should be 200
    And the response should have value as "{{ invalid.template.syntax.missing.close"

  Scenario: Template referencing non-existent context
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/missing-context': {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                userId: { type: 'string' }
              }
            },
            overrides: {
              userId: '{{ nonexistent.property }}'
            }
          }
        })
      """
    When I request "GET /api/missing-context"
    Then the status should be 200
    And the response should have userId as "{{ nonexistent.property }}"

  Scenario: Extremely large array count
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/huge-array': {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' }
                }
              }
            },
            count: 100000
          }
        })
      """
    When I request "GET /api/huge-array"
    Then the status should be 500
    And the response should contain error information about resource limits

  Scenario: Invalid count value
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/negative-count': {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' }
                }
              }
            },
            count: -5
          }
        })
      """
    When I request "GET /api/negative-count"
    Then the status should be 200
    And the response should be an empty array

  Scenario: Schema with unsupported features
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/unsupported': {
            schema: {
              type: 'object',
              properties: {
                complex: {
                  type: 'string',
                  pattern: '^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)[a-zA-Z\\d]{8,}$',
                  customFaker: 'this.is.not.supported'
                }
              }
            }
          }
        })
      """
    When I request "GET /api/unsupported"
    Then the status should be 200
    And the response should have a complex field with generated string

  Scenario: Missing schema plugin
    Given I create a mock with:
      """
      schmock()
        .routes({
          'GET /api/no-plugin': {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'integer' }
              }
            }
          }
        })
      """
    When I request "GET /api/no-plugin"
    Then the status should be 500
    And the response should contain error information about no plugin to handle route

  Scenario: Schema plugin with corrupted faker integration
    Given I create a mock with corrupted faker:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/corrupted-faker': {
            schema: {
              type: 'object',
              properties: {
                email: { type: 'string', format: 'email' }
              }
            }
          }
        })
      """
    When I request "GET /api/corrupted-faker"
    Then the status should be 500
    And the response should contain error information about faker corruption

  Scenario: Memory exhaustion with deeply nested objects
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/deep-nesting': {
            schema: {
              type: 'object',
              properties: {
                level1: {
                  type: 'object',
                  properties: {
                    level2: {
                      type: 'object',
                      properties: {
                        level3: {
                          type: 'object',
                          properties: {
                            level4: {
                              type: 'object',
                              properties: {
                                level5: {
                                  type: 'array',
                                  items: {
                                    type: 'object',
                                    properties: {
                                      data: { type: 'string' }
                                    }
                                  },
                                  maxItems: 1000
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        })
      """
    When I request "GET /api/deep-nesting"
    Then the status should be 500
    And the response should contain error information about resource limits

  Scenario: Invalid override data types
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/type-mismatch': {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                active: { type: 'boolean' }
              }
            },
            overrides: {
              id: 'not-a-number',
              active: 'not-a-boolean'
            }
          }
        })
      """
    When I request "GET /api/type-mismatch"
    Then the status should be 200
    And the response should have id as "not-a-number"
    And the response should have active as "not-a-boolean"

  Scenario: Network simulation - timeout during generation
    Given I create a mock with slow generation:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/slow-generation': {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  heavyComputation: { type: 'string' }
                }
              }
            },
            count: 50
          }
        })
      """
    When I request "GET /api/slow-generation" with timeout 100ms
    Then the status should be 500
    And the response should contain error information about timeout

  Scenario: Plugin initialization failure
    Given I create a mock with failing plugin initialization:
      """
      schmock()
        .use(corruptedSchemaPlugin())
        .routes({
          'GET /api/plugin-fail': {
            schema: {
              type: 'object',
              properties: {
                data: { type: 'string' }
              }
            }
          }
        })
      """
    When I request "GET /api/plugin-fail"
    Then the status should be 500
    And the response should contain error information about plugin failure

  Scenario: Invalid array schema configuration
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/invalid-array': {
            schema: {
              type: 'array',
              items: null
            }
          }
        })
      """
    When I request "GET /api/invalid-array"
    Then the status should be 500
    And the response should contain error information about invalid array schema

  Scenario: Resource limits - too many concurrent requests
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/concurrent': {
            schema: {
              type: 'object',
              properties: {
                timestamp: { type: 'string', format: 'date-time' }
              }
            }
          }
        })
      """
    When I make 1000 concurrent requests to "GET /api/concurrent"
    Then all requests should complete
    And some requests may have status 500 due to resource limits
    And error responses should contain meaningful error messages

  Scenario: Schema validation edge case - empty schema
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/empty-schema': {
            schema: {}
          }
        })
      """
    When I request "GET /api/empty-schema"
    Then the status should be 500
    And the response should contain error information about empty schema

  Scenario: Faker method does not exist
    Given I create a mock with:
      """
      schmock()
        .use(schemaPlugin())
        .routes({
          'GET /api/nonexistent-faker': {
            schema: {
              type: 'object',
              properties: {
                field: {
                  type: 'string',
                  faker: 'nonexistent.method.that.does.not.exist'
                }
              }
            }
          }
        })
      """
    When I request "GET /api/nonexistent-faker"
    Then the status should be 500
    And the response should contain error information about unknown faker method