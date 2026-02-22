# Integration Test Research: Prism Issues Mapped to Schmock

> Research conducted Feb 2026. Based on Stoplight Prism GitHub issues cross-referenced
> against Schmock's OpenAPI plugin architecture (parser, normalizer, CRUD detector, plugin).

---

## HIGH RISK — Likely to surface bugs in Schmock

### 1. readOnly nested in allOf not detected
**Prism issue**: #1920
**Problem**: `readOnly: true` buried inside an `allOf` branch (e.g., `allOf: [{ readOnly: true }, { $ref }]`) is not stripped from request schemas.
**Schmock component**: `normalizer.ts` lines 100-146 — readOnly detection checks `node.properties[prop].readOnly` but does NOT check for readOnly inside `allOf` branches of a property. The normalizer recurses into allOf (lines 190-197), but readOnly detection happens at the property level before recursion.
**Test**: POST a request body where a required field has `readOnly: true` via allOf composition. With `validateRequests: true`, it should NOT require that field.

### 2. nullable + allOf produces broken schema
**Prism issue**: #1294
**Problem**: `nullable: true` combined with `allOf` (e.g., `{ nullable: true, allOf: [{ $ref }] }`) produces `oneOf: [{ allOf: [...] }, { type: "null" }]`. json-schema-faker may struggle with nested allOf inside oneOf.
**Schmock component**: `normalizer.ts` lines 47-55 — wraps in oneOf without flattening allOf first.
**Test**: Define a schema with `nullable: true` + `allOf` composition. Verify generated response is either null or a valid object (not `{}` or crash).

---

## MEDIUM RISK — Potential issues under specific conditions

### 3. Discriminator mapping ignored during AJV request validation
**Prism issues**: #2345, #1864
**Problem**: AJV doesn't support OpenAPI discriminator mapping. With `validateRequests: true`, request bodies with discriminated unions validate against ALL branches instead of the mapped one.
**Schmock component**: `plugin.ts` validateRequestBody uses AJV. Normalizer injects `enum` constraints for generation but AJV may not use them for validation correctly.
**Test**: POST with discriminator value "cat" but include "dog-only" properties. With validation enabled, verify behavior.

### 4. 406 for 204/HEAD responses when Accept header present
**Prism issues**: #584, #575
**Problem**: Content negotiation checks ALL response content types, not just the one that will be returned. A 204 No Content or HEAD response with `Accept: text/xml` fails 406 even though there's no body.
**Schmock component**: `plugin.ts` processContentNegotiation (lines 317-355) collects content types from ALL response entries, not filtered by the response that will actually be returned.
**Test**: Spec with 200 (application/json) and 204 (no content). Request DELETE (which returns 204) with `Accept: text/xml`. Should NOT get 406.

### 5. "default" and wildcard status codes silently dropped
**Prism issues**: #1531, #982
**Problem**: Parser skips `"default"` status code (line: `if (statusCode === "default") continue`). Also skips wildcard codes like `"2XX"` because `Number.parseInt("2XX")` returns NaN.
**Schmock component**: `parser.ts` — `"default"` explicitly skipped, `"2XX"` silently dropped via NaN check. `generators.ts` createStaticGenerator only looks for 2XX responses.
**Test**: Spec with only a `default` response. Verify the route still works (returns something, not crash). Spec with `"2XX"` wildcard status — verify behavior.

### 6. Server basePath handling
**Prism issue**: Discussion #906
**Problem**: Server URL pathname should be prepended to route paths. If spec has `servers: [{ url: "https://api.example.com/v1" }]`, routes should be registered at `/v1/pets`, not `/pets`.
**Schmock component**: `parser.ts` extracts basePath from first server URL. Need to verify if it's prepended to path keys or if routes only match at root.
**Test**: Spec with server URL containing a path prefix. Verify routes are accessible with and without the prefix.

### 7. Nullable fields always generate non-null values
**Prism issues**: #2269, #486
**Problem**: After normalization to `oneOf: [{ type: "string" }, { type: "null" }]`, json-schema-faker may always pick the non-null branch.
**Schmock component**: `normalizer.ts` nullable handling + json-schema-faker behavior.
**Test**: Generate many responses for a schema with multiple nullable fields. At least some should contain null values (statistical test).

### 8. oneOf/allOf dynamic generation drops required fields
**Prism issue**: #570
**Problem**: Dynamic generation for complex composition schemas (oneOf with allOf branches) may drop required fields.
**Schmock component**: json-schema-faker behavior with complex compositions.
**Test**: Schema using `oneOf` where each branch has `required` fields + `allOf` composition. Verify generated data includes all required fields.

### 9. Redirect-only endpoints return empty 200
**Prism issue**: #982
**Problem**: Endpoints defining only 3XX responses (redirects) get empty 200 instead of the defined redirect.
**Schmock component**: `generators.ts` createStaticGenerator only looks for 2XX. Falls back to `[200, {}]`.
**Test**: Spec with an endpoint that only defines 301/302 responses. Verify the response status code.

### 10. API key in query/cookie always passes security
**Prism issue**: Architectural gap
**Problem**: `checkSchemePresence()` returns `true` for `apiKey` in `query` or `cookie` because Schmock has no query/cookie context in the security check.
**Schmock component**: `plugin.ts` lines 260-290.
**Test**: Spec with apiKey in query security. Make request without the API key. Verify it passes (documenting known behavior).

---

## LOW RISK — Unlikely to surface or already handled

### 11. Circular references (Prism #1456)
Schmock handles via WeakSet in normalizer. Already tested with scalar-galaxy.yaml.

### 12. readOnly + required in arrays (Prism #2336)
Schmock's recursive normalizer should handle this — each node processed independently.

### 13. Prefer header sticky across requests (Prism #1071)
Schmock reads Prefer fresh from each request. No state leakage.

### 14. Required fields in request body (Prism #419)
AJV properly validates required properties.

### 15. Path params with special chars (Prism #1762)
Express-style route matching handles this. Already tested in edge-cases.test.ts.

### 16. Swagger 2.0 security mapping (Prism #324)
Parser correctly maps `type: "basic"` to `{ type: "http", scheme: "basic" }`.

---

## Additional Schmock-Specific Edge Cases (from code review)

### 17. Content negotiation blocks Prefer header
Content negotiation runs BEFORE Prefer header processing. A `406` blocks `Prefer: code=404`, even if the error response has no content type requirement.
**Test**: Request with `Accept: text/xml` and `Prefer: code=404`. The 406 should take priority.

### 18. JSON pointer in callbacks doesn't handle RFC 6901 escaping
`$request.body#/callback~1url` should resolve to `callback/url` key, but Schmock's simple `/`-split doesn't handle `~0`/`~1` escaping.
**Test**: Callback with RFC 6901 escaped pointer. Verify resolution.

### 19. AJV singleton shared across openapi instances
If two different openapi plugins are piped into different schmock instances, they share the same AJV instance. Schema name collisions possible.
**Test**: Two schmock instances, each with different openapi specs that have same-named schemas but different shapes.

### 20. Event listener errors break request handling
If a listener throws in `emit()`, it propagates up and can break request handling. No try/catch around listener calls.
**Test**: Register a throwing event listener. Verify requests still complete (or document the failure).

### 21. isStatusTuple false positive
If a generator returns `[200, someData]` as a plain array (not intending a tuple), it's misinterpreted as `[status, body]`.
**Test**: Route with generator returning a 2-element array `[200, "data"]`. Verify if it's treated as tuple or array response.

### 22. Prefer example with quoted names
`Prefer: example="my example"` — the quotes are included in the name, not stripped.
**Test**: Named example with spaces. Verify Prefer header with and without quotes.

### 23. findJsonContent fallback to non-JSON content type
Parser's `findJsonContent()` falls back to first available content type, even if it's `application/xml`.
**Test**: Spec with only `application/xml` content type. Verify parser behavior.

### 24. Server URL variables not substituted
`servers: [{ url: "https://api.example.com/{version}", variables: { version: { default: "v1" } } }]` — the `{version}` literal ends up in the basePath.
**Test**: Spec with server URL variables. Verify basePath extraction.

---

## Existing Coverage (already in 49 tests)

| Area | Covered By |
|------|-----------|
| Basic CRUD via HTTP | full-pipeline: Petstore CRUD |
| Circular refs | full-pipeline: Scalar Galaxy |
| Seed data | full-pipeline: Pipeline with seed data |
| Request history | full-pipeline: Request history through HTTP |
| Reset lifecycle | full-pipeline: Reset mid-session |
| Prefer: dynamic=true | full-pipeline: Dynamic generation |
| Security (bearer) | full-pipeline: Security validation |
| Unicode body/path | edge-cases: Unicode tests |
| Huge payloads | edge-cases: 1MB JSON, 10K items |
| Concurrency | edge-cases: 50 parallel, mixed methods |
| Malformed input | edge-cases: Malformed JSON, missing content-type |
| Trailing slash | edge-cases: Trailing slash normalization |
| Headers case | edge-cases: Headers case insensitivity |
| Port reuse | edge-cases: Port reuse after close |
| Express + CRUD | adapter-openapi: Express + petstore |
| Express + security | adapter-openapi: Express + security |
| Express + Prefer | adapter-openapi: Express + Prefer header |
| faker + validation | multi-plugin: faker + validation |
| faker + query | multi-plugin: pagination, sorting, filtering |
| openapi + faker + validation | multi-plugin: schema compliance |
| openapi + faker + query | multi-plugin: pagination on list |
| All plugins + HTTP | multi-plugin: Three plugins + listen |
| CLI CRUD | cli-integration: CLI with petstore |
| CLI seed/CORS/admin | cli-integration: Various CLI tests |
