Feature: OpenAPI request pipeline review fixes
  As a developer mocking an API from its OpenAPI spec
  I want Prefer, callbacks, seeding and status selection to behave predictably
  So that the mock never answers with data it did not store or silently ignores my config

  # ── Prefer is a pure simulation on CRUD mutations ───────────────────────

  Scenario: A Prefer code override on a create returns the simulated body and stores nothing
    Given a review mock with a CRUD pet spec
    When I create a review pet named "Alice" with Prefer "code=201"
    Then the review response status is 201
    When I list the review pets
    Then the review pet list is empty

  Scenario: A Prefer dynamic create stores nothing
    Given a review mock with a CRUD pet spec
    When I create a review pet named "Alice" with Prefer "dynamic=true"
    Then the review response status is 201
    When I list the review pets
    Then the review pet list is empty

  Scenario: A Prefer example create returns the example and stores nothing
    Given a review mock with a CRUD pet spec
    When I create a review pet named "Alice" with Prefer "example=sample"
    Then the review response status is 201
    And the review response body name is "Example"
    When I list the review pets
    Then the review pet list is empty

  Scenario: A Prefer code override on an update leaves the stored item unchanged
    Given a review mock with a CRUD pet spec seeded with "Buddy"
    When I rename the seeded review pet to "Renamed" with Prefer "code=200"
    Then the review response status is 200
    When I read the seeded review pet
    Then the review response body name is "Buddy"

  Scenario: A Prefer code override on a delete keeps the stored item
    Given a review mock with a CRUD pet spec seeded with "Buddy"
    When I delete the seeded review pet with Prefer "code=204"
    Then the review response status is 204
    When I read the seeded review pet
    Then the review response status is 200

  Scenario: A Prefer header with no mock directive still commits the create
    Given a review mock with a CRUD pet spec
    When I create a review pet named "Alice" with Prefer "return=representation"
    Then the review response status is 201
    When I list the review pets
    Then the review pet list holds one pet named "Alice"

  # ── Prefer parsing follows RFC 7240 ──────────────────────────────────────

  Scenario Outline: RFC 7240 spellings of a Prefer example are honoured
    Given a review mock with a CRUD pet spec seeded with "Buddy"
    When I read the seeded review pet with Prefer <prefer>
    Then the review response body name is "Example"

    Examples:
      | prefer                 |
      | example="sample"       |
      | Example=sample         |
      | example=sample; foo=1  |
      | EXAMPLE = "sample"     |

  Scenario: An uppercase Prefer code token is honoured
    Given a review mock with a CRUD pet spec seeded with "Buddy"
    When I read the seeded review pet with Prefer "CODE=404"
    Then the review response status is 404

  Scenario: The bare Prefer dynamic token regenerates from the schema
    Given a review mock with a CRUD pet spec seeded with "Buddy"
    When I read the seeded review pet with Prefer "dynamic"
    Then the review response status is 200
    And the review response body name is not "Buddy"

  # ── onSchema sees one path shape ─────────────────────────────────────────

  Scenario: onSchema receives the template path when Prefer regenerates the body
    Given a review mock recording onSchema contexts
    When I read the seeded review pet with Prefer "code=200"
    Then every recorded onSchema path is "/pets/:id"
    And every recorded onSchema context has only the documented keys

  # ── Callback URL expressions ─────────────────────────────────────────────

  Scenario: A callback URL embeds an integer id from the response body
    Given a review mock with a callback URL "{$request.body#/callbackUrl}/pets/{$response.body#/id}"
    When I create a review pet with callback URL "https://hooks.example"
    Then the review callback was dispatched to "https://hooks.example/pets/1"

  Scenario: A callback header expression matches a mixed-case request header
    Given a review mock with a callback URL "{$request.header.X-Hook}/events"
    When I create a review pet sending header "X-Hook" as "https://hooks.example"
    Then the review callback was dispatched to "https://hooks.example/events"

  Scenario: A callback URL with an unresolvable expression is skipped and debug mode says why
    Given a review mock in debug mode with a callback URL "{$request.body#/callbackUrl}/pets/{$request.body#/missing}"
    When I create a review pet with callback URL "https://hooks.example"
    Then no review callback was dispatched
    And a warning names the unresolved expression "$request.body#/missing"

  Scenario: A callback the client did not opt into is skipped quietly
    Given a review mock with a callback URL "{$request.body#/callbackUrl}/pets/{$response.body#/id}"
    When I create a review pet without a callback URL
    Then no review callback was dispatched
    And no warning was logged

  # ── Seed configuration is validated ──────────────────────────────────────

  Scenario: A seed key naming no resource is rejected
    When I build a review mock seeding the key "petz" with an inline array
    Then the review build fails with code "OPENAPI_UNKNOWN_SEED_RESOURCE"
    And the review build error lists the resource "pets"

  Scenario: A count seed key naming no resource is rejected the same way
    When I build a review mock seeding the key "petz" with a count of 2
    Then the review build fails with code "OPENAPI_UNKNOWN_SEED_RESOURCE"

  Scenario: A numeric seed is rejected with a pointer to fakerSeed
    When I build a review mock with a numeric seed of 42
    Then the review build fails with code "OPENAPI_INVALID_OPTION"
    And the review build error mentions "fakerSeed"

  Scenario: A seed entry of an unknown shape is rejected
    When I build a review mock seeding "pets" with a "counts" object
    Then the review build fails with code "OPENAPI_INVALID_OPTION"

  # ── Resource override keys are validated ─────────────────────────────────

  Scenario: A resources override key naming no resource is rejected
    When I build a review mock overriding the resource "petz"
    Then the review build fails with code "OPENAPI_UNKNOWN_RESOURCE_OVERRIDE"
    And the review build error lists the resource "pets"

  Scenario: A resources override keyed by a resource's pre-rename name points at its new name
    When I build a review mock of "/repos/{owner}/{repo}" overriding the resource ":owner"
    Then the review build fails with code "OPENAPI_UNKNOWN_RESOURCE_OVERRIDE"
    And the review build error names "repos" as the key to use

  # ── Create status selection ──────────────────────────────────────────────

  Scenario: A create declaring both 201 and 200 answers 201
    Given a review mock whose create declares both 201 and 200
    When I create a review pet named "Alice"
    Then the review response status is 201

  # ── Public option types ──────────────────────────────────────────────────

  Scenario: The exported option types alias the ambient Schmock types
    Given the option types the openapi package exports
    Then each one is exactly the ambient Schmock type it names
