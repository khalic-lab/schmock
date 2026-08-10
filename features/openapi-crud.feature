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

  Scenario: A PUT-only item contract does not expose PATCH
    Given a mock with a spec declaring PUT but not PATCH on the item path
    When I create a widget
    And I PATCH the widget
    Then the response status is 404
    And the response has error code "ROUTE_NOT_FOUND"
    When I PUT the widget
    Then the response status is 200
    And the response header "x-replaced-by" is "put"

  Scenario: A PATCH-only item contract does not expose PUT
    Given a mock with a spec declaring PATCH but not PUT on the item path
    When I create a widget
    And I PUT the widget
    Then the response status is 404
    And the response has error code "ROUTE_NOT_FOUND"
    When I PATCH the widget
    Then the response status is 200

  Scenario: PUT and PATCH keep their own declared response contracts
    Given a mock with a spec declaring PUT 200 with a header and PATCH 204 empty
    When I create a widget
    And I PUT the widget
    Then the response status is 200
    And the response header "x-update-mode" is "replace"
    When I PATCH the widget
    Then the response status is 204
    And the response has no body
    And the response does not have header "x-update-mode"

  Scenario: A Prefer code override does not commit a create
    Given a mock with a transactional pet spec
    When I create a pet forcing the 400 response
    Then the transactional response status is 400
    When I list the transactional pets
    Then the transactional list is empty

  Scenario: An unacceptable media type does not commit an update
    Given a mock with a transactional pet spec seeded with one pet
    When I update the seeded pet asking for XML
    Then the transactional response status is 406
    When I read the seeded pet
    Then the transactional response status is 200
    And the seeded pet still has name "Buddy"

  Scenario: A response validation failure does not commit a delete
    Given a mock with a transactional pet spec seeded with one pet and response validation
    When I delete the seeded pet
    Then the transactional response status is 500
    And the transactional response has error code "RESPONSE_VALIDATION_ERROR"
    When I read the seeded pet
    Then the transactional response status is 200
    And the seeded pet still has name "Buddy"
    When I list the transactional pets
    Then the transactional list contains 1 item

  Scenario: Same-named collections at different paths are isolated
    Given a mock with a spec declaring CRUD on two same-named collections
    When I create a user under the root collection
    Then the scoped response status is 201
    When I list the admin users
    Then the scoped list is empty
    When I list the root users
    Then the scoped list contains 1 item

  Scenario: Nested collections are isolated per parent id
    Given a mock with a spec declaring CRUD on two same-named collections
    When I create a pet under owner 1
    Then the scoped response status is 201
    When I list the pets of owner 2
    Then the scoped list is empty
    When I list the pets of owner 1
    Then the scoped list contains 1 item
    When I read owner 1's pet under owner 2
    Then the scoped response status is 404

  Scenario: Methods a CRUD group declares but CRUD cannot serve are still registered
    Given a mock with a spec declaring HEAD on the item path and OPTIONS on the collection
    When I send HEAD to a widget
    Then the response status is 200
    When I send OPTIONS to the widget collection
    Then the response status is 204

  Scenario: Schema overrides apply before CRUD detection and seeding
    Given a mock with the Petstore spec, a list schema override and a generated seed
    When I list all pets
    Then the list contains 2 seeded pets
    And every seeded pet has property "nickname"
    And no seeded pet has property "tag"

  Scenario: Create returns the declared response contract
    Given a mock with a spec whose create declares a full item contract
    When I create a thing labelled "a"
    Then the created thing has a string "id"
    And the created thing has property "createdAt"
    And the created thing has no property "thingId"
    When I read the created thing by its returned id
    Then the contract read response has status 200

  Scenario: onSchema is invoked for CRUD responses
    Given a mock with the Petstore OpenAPI 3 spec and a recording onSchema callback
    When I create a pet named "Buddy" through the recording mock
    Then the onSchema callback recorded method "POST" on path "/pets"
    And the onSchema callback context carried params, query and headers
    And the created pet has property "generatedBy" equal to "onSchema"

  Scenario: CRUD responses honor the negotiated media type
    Given a mock with a spec whose widget list declares JSON and XML contracts
    When I list widgets accepting "application/xml"
    Then the negotiated list body comes from the XML branch
