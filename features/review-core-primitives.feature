Feature: Core primitives shared by every transport
  As a developer using Schmock through several transports
  I want core to own the helpers that parse prefixes, methods and Node requests
  So that mock.listen(), the fetch interceptor and the adapters cannot drift apart

  # ── One trailing-slash rule for namespaces and baseUrl ─────────────────────

  Scenario: A namespace with a trailing slash behaves exactly like one without
    Given a mock with namespace "/api" and a mock with namespace "/api/", each with routes "GET /" and "GET /users"
    When I request "/api", "/api/", "/api/users", "/api//users" and "/apiv2/users" from both mocks
    Then both mocks answer 200, 200, 200, 404 and 404

  Scenario: The namespace and the interceptor baseUrl share one prefix rule
    Given the path prefix parsed from "/api/"
    Then it equals the path prefix parsed from "/api"
    And it matches "/api" and "/api/users" but not "/apiv2" or "/"

  # ── toHttpMethod ───────────────────────────────────────────────────────────

  Scenario: toHttpMethod rejects an unknown verb with a SchmockError
    When I convert the method "PROPFIND" with toHttpMethod
    Then it throws an InvalidHttpMethodError with code "INVALID_HTTP_METHOD"
    And the error is a SchmockError whose message names the verb

  # ── mock.listen() and serveNodeRequest answer client errors alike ──────────

  Scenario: mock.listen() answers an unsupported method with 405 and Allow
    Given a listening mock with a route "GET /users"
    When a raw client sends "PROPFIND /users" with Host "127.0.0.1"
    Then the raw response status is 405 with code "METHOD_NOT_ALLOWED"
    And the raw response Allow header is "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS"

  Scenario: mock.listen() answers a malformed Host header with 400
    Given a listening mock with a route "GET /users"
    When a raw client sends "GET /users" with a Host header that has an unclosed bracket
    Then the raw response status is 400 with code "BAD_REQUEST"

  Scenario: A server built on serveNodeRequest answers every request like mock.listen()
    Given a listening mock with a route "GET /users"
    And a Node server that serves the same mock through serveNodeRequest
    When the same raw requests are sent to both servers
    Then both servers answer each request with the same status and code

  Scenario: serveNodeRequest writes extra headers on success and error answers
    Given a listening mock with a route "GET /users"
    And a Node server that serves the same mock through serveNodeRequest with an "x-served-by" extra header
    When a raw client sends "GET /users" and then "PROPFIND /users" to that server
    Then both raw responses carry the "x-served-by" header
    And the extra-headers hook saw a success answer and then an error answer

  # ── Plugin hook types ──────────────────────────────────────────────────────

  Scenario: A plugin whose synchronous hooks are not annotated still pipes and uninstalls
    Given a plugin object literal with unannotated install and uninstall hooks
    When I pipe it into a mock and reset the mock
    Then its install and uninstall hooks both ran
