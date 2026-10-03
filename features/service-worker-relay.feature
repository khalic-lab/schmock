Feature: Service worker relay
  As a developer inspecting a browser app in Chrome DevTools
  I want requests Schmock mocks to be answered by a service worker
  So that they appear as native rows in the Network panel, XHR included

  Scenario: A mocked fetch is answered by the service worker
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    When the page fetches "/api/users"
    Then the relay is active
    And the page received status 200 with the mocked users
    And the browser saw "GET http://localhost/api/users" served by the service worker
    And the network received no request

  Scenario: A mocked XHR is answered by the service worker
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    When the page sends an XHR for "/api/users"
    Then the page received status 200 with the mocked users
    And the browser saw "GET http://localhost/api/users" served by the service worker

  Scenario: One relayed request consults the mock once
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    And the mock records its lifecycle events
    When the page fetches "/api/users"
    Then the mock emitted "request:start,request:match,request:end"

  Scenario: A request no mock answers is fetched by the worker
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    When the page fetches "/api/other"
    Then the page received the network's response
    And the worker fetched "GET http://localhost/api/other" from the network

  Scenario: Script and navigation requests never reach the page
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    And the mock records its lifecycle events
    When the page loads a "script" from "/api/users"
    And the page navigates to "/api/users"
    Then the network answered both requests directly
    And the mock emitted no lifecycle events

  Scenario: A passthrough-off lease does not answer asset requests
    Given a page whose mock answers "GET /api/users" with users with passthrough disabled and whose relay has started
    When the page loads a "script" from "/assets/app.js"
    Then the network answered the request directly

  Scenario: A page that has not started the relay is not relayed
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    And a second page that never started the relay
    When the second page sends an XHR for "/api/users"
    Then the network answered the request directly

  Scenario: Each tab's requests go to the tab that made them
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    And a second page whose relay answers every request with:
      """
      { "tab": "second" }
      """
    When the second page sends an XHR for "/api/users"
    And the page sends an XHR for "/api/users"
    Then the second page received:
      """
      { "tab": "second" }
      """
    And the page received status 200 with the mocked users
    And the mock answered 1 request

  Scenario: Aborting a relayed request cancels it in the mock
    Given a page whose mock answers "GET /api/slow" after it is released and whose relay has started
    And the mock records its request:end statuses
    When the page sends an XHR for "/api/slow" and aborts it while the route runs
    Then the mock ended the request with status 499

  Scenario: A failing hook reaches the caller as a network error
    Given a page whose mock answers "GET /api/users" with users through a beforeResponse hook that throws "hook failed" and whose relay has started
    When the page fetches "/api/users" expecting a rejection
    Then the fetch rejected with a TypeError
    And the page console logged the original error "hook failed"

  Scenario: Binary bodies survive the relay byte for byte
    Given a page whose mock echoes the bytes posted to "POST /api/blob" and whose relay has started
    When the page sends an XHR posting the bytes "0,1,2,255" as "application/octet-stream" to "/api/blob"
    Then the page received the bytes "0,1,2,255"

  Scenario: Multipart form fields reach the route
    Given a page whose mock answers "POST /api/form" with its form field "name" and whose relay has started
    When the page sends an XHR posting a form with "name" set to "Ada" to "/api/form"
    Then the page received:
      """
      { "name": "Ada" }
      """

  Scenario: A 204 response crosses the relay without a body
    Given a page whose mock answers "DELETE /api/users/1" with no content and whose relay has started
    When the page sends an XHR with method "DELETE" for "/api/users/1"
    Then the page received status 204 and an empty body

  Scenario: Response headers cross the relay
    Given a page whose mock answers "GET /api/users" with users and header "x-total-count" set to "42" and whose relay has started
    When the page sends an XHR for "/api/users"
    Then the page received header "x-total-count" set to "42"

  Scenario: An origin-form baseUrl naming the page origin matches a relative request
    Given a page whose mock answers "GET /api/users" with users under the baseUrl "http://localhost/api" and whose relay has started
    When the page fetches "/api/users"
    Then the page received status 200 with the mocked users

  Scenario: The relay registers the configured script without the HTTP cache
    Given an empty page at "/mocks/index.html" with the Schmock worker available at "/mocks/schmock-sw.js"
    When the page starts the relay with:
      """
      { "url": "/mocks/schmock-sw.js", "scope": "/mocks/" }
      """
    Then the worker was registered from "/mocks/schmock-sw.js" with scope "/mocks/" and updateViaCache "none"
    And the relay is active

  Scenario: A scope wider than the script's directory falls back with the init command
    Given an empty page at "/index.html" with the Schmock worker available at "/mocks/schmock-sw.js"
    When the page starts the relay with:
      """
      { "url": "/mocks/schmock-sw.js", "scope": "/" }
      """
    Then the relay fell back with reason "registration-failed"
    And the page console warned with "npx schmock-devtools init"

  Scenario: A worker script that fails to install falls back
    Given a page whose worker script throws while installing
    When the page starts the relay
    Then the relay fell back with reason "registration-failed"
    And the page console warned with "the worker failed to install"

  Scenario: Stopping the relay returns fetch answering to the page
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    When the page stops the relay
    And the page fetches "/api/users"
    And the page sends an XHR for "/api/users"
    Then the relay is not active
    And the fetch was answered in the page with status 200 without the browser seeing it
    And the network answered the XHR directly

  Scenario: A request the worker relays after stop is still answered by the mock
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    When the page stops the relay
    And the worker relays "GET http://localhost/api/users" to the page anyway
    Then the page answered the relayed request with status 200

  Scenario: The relay survives a worker restart
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    When the worker restarts with fresh memory
    And the page sends an XHR for "/api/users"
    Then the page received status 200 with the mocked users
    And the browser saw "GET http://localhost/api/users" served by the service worker

  Scenario: A restarted worker holds other pages' requests until its registry loads, then sends them to the network
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    And a second page that never started the relay
    When the worker restarts with fresh memory while its client registry is still loading
    And the second page sends an XHR for "/api/users" without waiting for it
    And the worker's client registry finishes loading
    Then the second page received the network's response through the service worker

  Scenario: A restarted worker holds the relaying page's requests until its registry loads, then relays them
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    When the worker restarts with fresh memory while its client registry is still loading
    And the page sends an XHR for "/api/users" without waiting for it
    And the worker's client registry finishes loading
    Then the page received status 200 with the mocked users
    And the browser saw "GET http://localhost/api/users" served by the service worker

  Scenario: A worker update re-establishes the relay
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    When a new worker version takes control of the page
    Then the relay is active
    And the new worker received a hello from the page
    And the page sending an XHR for "/api/users" is answered by the service worker with status 200

  Scenario: A worker update during startup is followed
    Given a page whose mock answers "GET /api/users" with users and whose worker is replaced by a new version during the handshake
    When the page starts the relay
    Then the relay is active
    And the new worker received a hello from the page
    And the page sending an XHR for "/api/users" is answered by the service worker with status 200

  Scenario: A page that goes into the back-forward cache keeps its relay
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    When the page is hidden into the back-forward cache and shown again
    And the page sends an XHR for "/api/users"
    Then the page received status 200 with the mocked users

  Scenario: A page that unloads says goodbye
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    When the page unloads
    Then the worker no longer relays requests from that page

  Scenario: A hard-reloaded page asks the worker to take control
    Given a worker that is already active
    And a page whose mock answers "GET /api/users" with users and that the worker does not control
    When the page starts the relay
    Then the worker received a claim request
    And the relay is active

  Scenario: A page the worker cannot claim falls back
    Given a worker that is already active
    And a page whose mock answers "GET /api/users" with users and that the worker cannot claim
    When the page starts the relay with a timeout of 50 ms
    Then the relay fell back with reason "not-controlled"
    And the page console warned with "reload normally"

  Scenario: Another service worker on the scope is left alone
    Given a page whose scope is controlled by another service worker "/app-sw.js"
    When the page starts the relay
    Then the relay fell back with reason "scope-taken"
    And no service worker was registered
    And the page console warned with "/app-sw.js"

  Scenario: A service worker on a parent scope does not block Schmock's own scope
    Given a page at "/app/index.html" controlled by another service worker "/app-sw.js" registered with scope "/"
    And the page's mock answers "GET /app/api/users" with users
    When the page starts the relay with:
      """
      { "url": "/schmock-sw.js", "scope": "/app/" }
      """
    Then the relay is active
    And the service worker registered with scope "/" is still registered
    And the page sending an XHR for "/app/api/users" is answered by the service worker with status 200

  Scenario: A page that another worker keeps under its narrower scope falls back and names that worker
    Given a page at "/app/index.html" controlled by another service worker "/app/app-sw.js" registered with scope "/app/"
    And the page's mock answers "GET /app/api/users" with users
    When the page starts the relay with a timeout of 50 ms
    Then the relay fell back with reason "not-controlled"
    And the page console warned with "/app/app-sw.js"

  Scenario: A worker script from another protocol keeps the page in fallback
    Given a page whose worker answers the handshake with protocol 99
    When the page starts the relay
    Then the relay fell back with reason "protocol-mismatch"
    And the page console warned with "npx schmock-devtools init"
    And the page's fetches are still answered in the page

  Scenario: A worker copied from another package version only warns
    Given a page whose worker answers the handshake with the current protocol and version "0.0.1"
    When the page starts the relay
    Then the relay is active
    And the page console warned with "0.0.1"

  Scenario: A missing worker script falls back with the init command
    Given a page whose worker script is not served
    When the page starts the relay
    Then the relay fell back with reason "registration-failed"
    And the page console warned with "npx schmock-devtools init"

  Scenario: A worker that never answers the handshake falls back
    Given a page whose worker never answers the handshake
    When the page starts the relay with a timeout of 50 ms
    Then the relay fell back with reason "timeout"

  Scenario: Without service worker support the relay falls back and mocking continues
    Given a page without service worker support whose mock answers "GET /api/users" with users
    When the page starts the relay
    And the page fetches "/api/users"
    Then the relay fell back with reason "unsupported"
    And the page received status 200 with the mocked users

  Scenario: An insecure page falls back
    Given an insecure page whose mock answers "GET /api/users" with users
    When the page starts the relay
    Then the relay fell back with reason "insecure-context"

  Scenario: Starting the relay twice gives the same relay
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    When the page starts the relay again with the same options
    Then both starts gave the same relay

  Scenario: Starting the relay again with other options is rejected
    Given a page whose mock answers "GET /api/users" with users and whose relay has started
    When the page starts the relay again with:
      """
      { "timeout": 100 }
      """
    Then starting rejects with a SchmockError with code "DEVTOOLS_RELAY_ALREADY_STARTED"

  Scenario: The devtools reporter reports relayed requests
    Given a page whose mock answers "GET /api/users" with users, piped with the devtools plugin, and whose relay has started
    When the page sends an XHR for "/api/users"
    Then exactly 1 collapsed console group was opened and closed
    And the group title reads "Schmock GET /api/users → 200" followed by the duration
