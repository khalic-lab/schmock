Feature: OpenAPI CRUD, Prefer and callback review fixes

  As a developer mocking an API from its OpenAPI spec
  I want CRUD routes, Prefer directives and callbacks to follow the declared contract
  So that the mock answers, stores and notifies what the real API would

  # ── Prefer directives ──────────────────────────────────────────────────────

  Scenario: A Prefer code outside the HTTP status range falls through to the normal response
    Given a status mock whose operation declares a 200 and a default response
    When I get the status with Prefer header "code=999"
    Then the status response is 200 with the declared success body
