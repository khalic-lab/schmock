Feature: Node ingress matches the fetch interceptor
  As a developer serving a mock with mock.listen() or the schmock CLI
  I want request bodies, query strings and response framing to match the fetch interceptor
  So that one mock behaves the same whichever transport carries the request

  Scenario: A urlencoded form body reaches the handler as an object
    Given a listening mock that records the body of POST /echo
    When I POST "name=Rex&age=3" to /echo as "application/x-www-form-urlencoded;charset=UTF-8"
    Then the recorded body should be the object {"name":"Rex","age":"3"}

  Scenario: A text body reaches the handler as a string
    Given a listening mock that records the body of POST /echo
    When I POST "plain words" to /echo as "text/plain; charset=utf-8"
    Then the recorded body should be the string "plain words"

  Scenario: A binary upload reaches the handler as intact bytes
    Given a listening mock that records the body of POST /echo
    When I POST the bytes 89 50 4e 47 ff d8 00 to /echo as "application/octet-stream"
    Then the recorded body should be an ArrayBuffer holding 89 50 4e 47 ff d8 00

  Scenario: A body sent without a content type reaches the handler as bytes
    Given a listening mock that records the body of POST /echo
    When I POST the bytes 7b 7d to /echo without a content type
    Then the recorded body should be an ArrayBuffer holding 7b 7d

  Scenario: A multipart upload reaches the handler as form data
    Given a listening mock that records the body of POST /echo
    When I POST a multipart form with field "name" set to "Rex" and a 3-byte file "photo" to /echo
    Then the recorded body should be form data whose "name" is "Rex" and whose "photo" file holds 3 bytes

  Scenario: A deeply nested JSON body is rejected before any handler runs
    Given a listening mock that records the body of POST /echo
    When I POST a JSON body nested 300 levels deep to /echo
    Then the HTTP status should be 400 with error code "JSON_TOO_DEEP"
    And no body should have been recorded

  Scenario: A JSON body nested exactly at the depth limit is accepted
    Given a listening mock that records the body of POST /echo
    When I POST a JSON body nested 256 levels deep to /echo
    Then the HTTP status should be 200

  Scenario: A fixed-size response carries a Content-Length header
    Given a listening mock whose GET /text returns "hello"
    When I GET /text with a raw Node HTTP client
    Then the raw response should carry content-length "5" and no transfer-encoding

  Scenario: A repeated query key resolves to its last value
    Given a listening mock that echoes the query of GET /echo
    When I GET "/echo?tag=a&tag=b"
    Then the echoed query should be {"tag":"b"}
