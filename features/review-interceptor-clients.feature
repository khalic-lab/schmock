Feature: Fetch interceptor review fixes
  As a developer mocking fetch in React and Vue apps
  I want every lease of a mock to keep its own options and the fetch transport
  to behave like a real backend
  So that composing providers or sending unusual requests never leaks to the network

  Scenario: An older lease whose hook rewrites the request still serves it
    Given a mock with route "GET /admin/users" and an outer lease that strips "/api"
    When an inner lease on the same mock adds a header under "/api/admin"
    And I fetch "/api/admin/users" through the nested leases
    Then the nested fetch should be served by the mock
    And the mock should have been consulted once per distinct effective request

  Scenario: An option-less inner lease does not shadow an outer rewriting lease
    Given a mock with route "GET /admin/users" and an outer lease that strips "/api"
    When an inner lease on the same mock has no options
    And I fetch "/api/admin/users" through the nested leases
    Then the nested fetch should be served by the mock

  Scenario: Identical leases of one mock still consult it once
    Given a mock with route "GET /admin/users" and two option-less leases
    When I fetch the unmatched path "/missing" through both leases
    Then the mock should report exactly one start, notfound and end event

  Scenario: A non-standard method passes through by default
    Given an intercepting mock with default options and a network backend
    When I fetch "https://dav.example.com/files/" with method "PROPFIND"
    Then the network backend should answer the request

  Scenario: A non-standard method is a route miss under passthrough false
    Given an intercepting mock with passthrough disabled and a network backend
    When I fetch "https://dav.example.com/files/" with method "PROPFIND"
    Then the fetch should answer 404 with code "ROUTE_NOT_FOUND"
    And the network backend should not have been called

  Scenario: A hook that produces a non-standard method passes through
    Given an intercepting mock whose beforeRequest rewrites the method to "PURGE"
    When I fetch "https://cdn.example.com/asset" with method "GET"
    Then the network backend should answer the request

  Scenario: Malformed JSON is a 400 when the mock owns every request
    Given a mock with a recording "POST /api/items" route and passthrough disabled
    When I post the JSON body '{"name": "x",}' to "/api/items"
    Then the fetch should answer 400 with code "MALFORMED_JSON"
    And the recording route should not have run
    And the mock history should be empty

  Scenario: An empty JSON body reaches the route as undefined
    Given a mock with a recording "POST /api/items" route and passthrough disabled
    When I post the JSON body '' to "/api/items"
    Then the recording route should have received an undefined body

  Scenario: A mocked response reports the request URL
    Given an intercepting mock with route "GET /api/page"
    When I fetch "http://localhost/api/page?cursor=2#top"
    Then the response url should be "http://localhost/api/page?cursor=2"

  Scenario: A hook throw with an unserializable formatter body falls back
    Given an intercepting mock whose beforeRequest throws and whose errorFormatter returns a bigint
    When I fetch "/api/boom" through the throwing hook
    Then the fetch should answer 500 with code "INTERNAL_ERROR"

  Scenario: A path baseUrl without a leading slash still scopes the lease
    Given an intercepting mock with route "GET /api/x" and baseUrl "api" with passthrough disabled
    When I fetch "/api/x" through the scoped lease
    Then the scoped fetch should be served by the mock
    And the network backend should not have been called
