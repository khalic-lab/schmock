Feature: OpenAPI CRUD Operations

  As a developer
  I want automatic CRUD operations from an OpenAPI spec
  So that I can mock REST APIs without manual route setup

  Scenario: Full CRUD lifecycle
    Given a mock with the Petstore spec loaded
    When I create a pet named "Buddy"
    Then the create response has status 201
    And the created pet has name "Buddy"
    When I read the created pet
    Then the read response has status 200
    And the pet has name "Buddy"
    When I update the pet name to "Max"
    Then the update response has status 200
    When I list all pets
    Then the list contains 1 item
    When I delete the pet
    Then the delete response has status 204
    When I list all pets after deletion
    Then the list is empty

  Scenario: Read non-existent resource returns 404
    Given a mock with the Petstore spec loaded
    When I read pet with id 999
    Then the response status is 404
    And the response has error code "NOT_FOUND"

  Scenario: Delete non-existent resource returns 404
    Given a mock with the Petstore spec loaded
    When I delete pet with id 999
    Then the response status is 404

  Scenario: CRUD operations honor contract-declared success statuses
    Given a mock with CRUD operations declaring custom success statuses
    When I create an item under the custom status contract
    Then the custom create response has status 202
    When I read the item under the custom status contract
    Then the custom read response has status 203
    When I update the item under the custom status contract
    Then the custom update response has status 202
    When I patch the item under the custom status contract
    Then the custom patch response has status 204 without a body
    When I list items under the custom status contract
    Then the custom list response has status 206
    When I delete the item under the custom status contract
    Then the custom delete response has status 200
