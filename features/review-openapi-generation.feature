Feature: OpenAPI generation review fixes

  As a developer mocking an API from its OpenAPI spec
  I want generated bodies, stored rows and response headers to follow the declared contract
  So that envelopes, access modes, examples and concurrent writes behave like the real API

  # ── Concurrent updates merge at commit time ────────────────────────────────

  Scenario: Concurrent PATCHes to one item keep both updates
    Given a pets mock seeded with pet 1 named "rex" with tag "old" and age 1
    When two PATCH requests to pet 1 run concurrently, one setting tag "new" and one setting age 9
    Then both PATCH responses have status 200
    And the PATCH that committed last answered with both updates
    And pet 1 is stored with tag "new" and age 9

  Scenario: Concurrent PATCHes through the fetch interceptor keep both updates
    Given a pets mock seeded with pet 1 named "rex" with tag "old" and age 1
    When two intercepted fetch PATCHes to pet 1 run concurrently, one setting tag "new" and one setting age 9
    Then pet 1 is stored with tag "new" and age 9

  # ── List envelopes ──────────────────────────────────────────────────────────

  Scenario Outline: A list envelope that declares another array first still carries the resource
    Given a zones mock whose list envelope is a <shape> declaring "errors" before "result", seeded with 2 zones
    When I list the zones
    Then the list response has status 200
    And the listed zones are the 2 seeded zones under "result"
    And no entry of "errors" carries a zone id
    And reading zone 1 returns a zone with a name

    Examples:
      | shape        |
      | plain object |
      | allOf        |

  Scenario: An untyped list envelope keeps its declared shape
    Given a pets mock whose list envelope declares "data" and "total" without a type
    And a pet named "Rex" has been created
    When I list the pets
    Then the list response has status 200
    And the list body carries the created pet under "data"
    And the list body has a numeric "total"

  Scenario Outline: A nested list envelope carries the collection at the nested path
    Given a pets mock whose list envelope nests the items under "<path>", with response validation
    And a pet named "Rex" has been created
    When I list the pets
    Then the list response has status 200
    And the list body carries the created pet under "<path>"

    Examples:
      | path           |
      | page.items     |
      | _embedded.pets |

  Scenario Outline: A list envelope whose array is <shape> still carries the collection
    Given a pets mock whose list envelope declares "items" as <shape> next to "total", with response validation
    And a pet named "Rex" has been created
    When I list the pets
    Then the list response has status 200
    And the list body carries the created pet under "items"

    Examples:
      | shape                               |
      | an array or null through anyOf      |
      | a nullable allOf of an array        |
      | an array or an object through oneOf |
      | an array without items              |

  Scenario Outline: A list envelope keeps its declared key order
    Given a pets mock whose list envelope is "<envelope>"
    And a pet named "Rex" has been created
    When I list the pets
    Then the list response has status 200
    And the list body's keys at "<level>" are "<keys>" in that order

    Examples:
      | envelope                    | level | keys            |
      | items before total          | .     | items,total     |
      | total between data and meta | .     | data,total,meta |
      | page with items before size | page  | items,size      |

  Scenario: A list contract with no array serves the declared object
    Given a settings mock whose list response is an object without any array, with response validation
    When I list the settings
    Then the list response has status 200
    And the list body is an object with a "mode"

  Scenario: A tall item under a list envelope keeps the envelope's siblings
    Given an items mock whose item nests 13 levels deep under an object, has_more, data envelope, seeded with 1 item, with response validation
    When I list the items
    Then the list response has status 200
    And the list body has "object" equal to "list" and a boolean "has_more"
    And the list body carries 1 item under "data"

  # ── Object examples ─────────────────────────────────────────────────────────

  Scenario: A partial object example does not replace generated objects
    Given a pets mock whose Pet schema carries a partial example, seeded with 3 pets, with response validation
    When I list the pets
    Then the list response has status 200
    And every listed pet has a "tag"
    When I get the featured pet
    Then the featured pet response has status 200 and a "tag"

  Scenario: A writeOnly field in an object example is not returned
    Given a profile mock whose User example includes a writeOnly password
    When I get the current user
    Then the current user response has status 200 and no "password"

  # ── Access modes on CRUD writes ─────────────────────────────────────────────

  Scenario Outline: writeOnly fields are neither echoed nor stored
    Given a users mock with a writeOnly password under an <contract> contract, with request and response validation
    When I create a user named "a" with password "hunter2"
    Then the create response has status 201 and no "password"
    And reading user 1 returns no "password"
    And listing users returns no "password"
    When I replace user 1 with name "z" and password "p2"
    Then the replace response has status 200 and no "password"
    And reading user 1 returns the name "z" and no "password"

    Examples:
      | contract |
      | open     |
      | closed   |

  Scenario: Client-sent readOnly fields do not overwrite server values
    Given a users mock with a readOnly createdAt
    When I create a user named "b" with createdAt "1999-01-01T00:00:00Z"
    Then the created user's createdAt is not "1999-01-01T00:00:00Z"
    When I patch user 1 with createdAt "2000-02-02T00:00:00Z" and name "c"
    Then user 1 keeps its createdAt and has the name "c"

  # ── Nullable typeless keywords ──────────────────────────────────────────────

  Scenario Outline: A nullable typeless <keyword> accepts null
    Given a mock whose request body declares a nullable typeless <keyword> status, with request validation
    When I post a thing whose status is null
    Then the thing request is accepted

    Examples:
      | keyword |
      | enum    |
      | const   |

  # ── Lone item reads ─────────────────────────────────────────────────────────

  Scenario: A lone item GET answers from its declared schema
    Given a mock whose spec declares only GET /users/{username}
    When I get user "octocat"
    Then the user response has status 200 and a "login"

  Scenario: A seeded lone item GET still serves its seeded rows
    Given a mock whose spec declares only GET /users/{username}, seeded with user "octocat"
    When I get user "octocat"
    Then the user response has status 200 and the login "octocat"
    When I get user "nobody"
    Then the user response has status 404

  Scenario: A resource whose collection path ends in a parameter is named after its last literal segment
    Given a mock declaring GET and DELETE on /repos/{owner}/{repo}, seeded under "repos" with repo "hello"
    When I get repo "hello" of owner "octo"
    Then the repo response has status 200 and the name "hello"

  # ── Response headers ────────────────────────────────────────────────────────

  Scenario: Response headers honour nullable types and bounds, and skip object defaults
    Given a mock with a route declaring a nullable integer, a bounded integer, an exclusive-bounded integer and an object-default header
    When I get the limits route
    Then header "X-Remaining" is "0"
    And header "X-Limit" is "1"
    And header "X-Floor" is "6"
    And header "X-Meta" is absent
