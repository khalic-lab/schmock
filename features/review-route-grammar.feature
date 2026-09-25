Feature: Unambiguous route grammar
  As a developer registering routes with several parameters in one segment
  I want every route key to compile to one unambiguous, linear-time pattern
  So that requests reach the right route with the right parameters and a long URL cannot stall the server

  Scenario: A hyphen between two parameters is a literal separator
    Given a mock with route "GET /range/:from-:to" echoing its params
    When I request "GET /range/1-5"
    Then the response status is 200
    And the echoed params are:
      | name | value |
      | from | 1     |
      | to   | 5     |

  Scenario: A hyphen inside a parameter name still belongs to the name
    Given a mock with route "GET /users/:user-id" echoing its params
    When I request "GET /users/42"
    Then the response status is 200
    And the echoed params are:
      | name    | value |
      | user-id | 42    |

  Scenario: A single parameter before a literal suffix still matches greedily
    Given a mock with route "GET /files/:name.json" echoing its params
    When I request "GET /files/report.v2.json"
    Then the response status is 200
    And the echoed params are:
      | name | value     |
      | name | report.v2 |

  Scenario: Hyphen-joined date parameters split at each separator
    Given a mock with route "GET /reports/:year-:month-:day" echoing its params
    When I request "GET /reports/2026-09-25"
    Then the response status is 200
    And the echoed params are:
      | name  | value |
      | year  | 2026  |
      | month | 09    |
      | day   | 25    |

  Scenario: Two parameters with nothing between them are rejected at registration
    Given a fresh mock
    When I register the route "GET /things/:a:b"
    Then registration fails with code "ROUTE_PARSE_ERROR" mentioning "adjacent"

  Scenario: An escaped colon is a literal, so custom methods route to their own handler
    Given a mock with route "POST /jobs/:job\:run" answering "run"
    And the same mock with route "POST /jobs/:job\:cancel" answering "cancel"
    When I request "POST /jobs/abc:cancel"
    Then the response status is 200
    And the answer is "cancel" with param "job" equal to "abc"
    And requesting "POST /jobs/abc" returns 404
    And the registered paths are "/jobs/:job\:run" and "/jobs/:job\:cancel"

  Scenario: A route whose only colon is escaped is a static route
    Given a mock with route "POST /jobs\:batchGet" answering "batch"
    When I request "POST /jobs:batchGet"
    Then the response status is 200
    And requesting "POST /jobsbatchGet" returns 404

  Scenario: A quoted parameter name may contain characters outside the plain grammar
    Given a mock with route 'GET /users/:"user.id"' echoing its params
    When I request "GET /users/42"
    Then the response status is 200
    And the echoed params are:
      | name    | value |
      | user.id | 42    |

  Scenario Outline: Several parameters in one segment do not backtrack on a long URL
    Given a mock with route "<route>" echoing its params
    When I request a path of "<prefix>" followed by "<count>" repetitions of "<unit>" and "/x"
    Then the response status is 404
    And the request took less than 250 milliseconds

    Examples:
      | route                          | prefix    | unit | count |
      | GET /reports/:year-:month-:day | /reports/ | a    | 2000  |
      | GET /reports/:year-:month-:day | /reports/ | a-   | 1000  |
      | GET /v/:major.:minor.:patch    | /v/       | 1.   | 2000  |
      | GET /range/:from-:to           | /range/   | a-   | 32000 |
