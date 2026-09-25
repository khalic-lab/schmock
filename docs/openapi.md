# OpenAPI Auto-Mocking

The `@schmock/openapi` plugin parses an OpenAPI (or Swagger 2.0) spec and auto-registers routes with CRUD behavior, schema-generated responses, security validation, and more.

```sh
bun install @schmock/openapi
```

## Basic Usage

```typescript
import { schmock } from '@schmock/core'
import { openapi } from '@schmock/openapi'

const mock = schmock({ state: {} })

mock.pipe(await openapi({
  spec: './petstore.yaml',
}))

// All routes from the spec are now registered
await mock.handle('GET', '/pets')
await mock.handle('POST', '/pets', { body: { name: 'Rex' } })
```

The spec can be a file path (YAML or JSON) or an inline object. **In a browser, only the inline object works** — see [Running in a browser](#running-in-a-browser).

```typescript
mock.pipe(await openapi({
  spec: {
    openapi: '3.0.3',
    info: { title: 'My API', version: '1.0.0' },
    paths: {
      '/items': {
        get: {
          responses: {
            '200': {
              description: 'List items',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } } }
                }
              }
            }
          }
        }
      }
    }
  }
}))
```

## Options

```typescript
openapi({
  spec: './api.yaml',          // required: file path or inline object
  seed: { ... },               // pre-populate resources with data
  validateRequests: true,      // validate request bodies against spec schemas
  validateResponses: true,     // validate generated responses against spec schemas
  security: true,              // enforce security schemes (API key, Bearer, Basic)
  fakerSeed: 42,               // deterministic data generation
  debug: true,                 // log CRUD detection decisions
  schemas: { ... },            // replace response schemas for specific routes
  onSchema: (schema, ctx) => { ... },  // modify schemas before generation
  resources: { ... },          // override CRUD detection per resource
  strict: true,                // validate the spec itself at load time
  refs: { external: true },    // resolve $refs outside the spec document
  callbacks: {                 // callbacks are disabled unless supplied
    dispatch: async (request) => {
      await callbackQueue.publish(request)
    },
  },
})
```

`queryFeatures` is currently unsupported. Supplying it throws
`OPENAPI_UNSUPPORTED_OPTION` instead of silently doing nothing.

## Loading the Spec

### External `$ref`s are opt-in

A spec is input, and `$ref` is a file-read and network primitive, so nothing
outside the root document resolves unless you ask for it. A spec containing an
unresolvable-by-policy `$ref` fails at construction with
`OPENAPI_EXTERNAL_REF_BLOCKED` rather than carrying a `$ref` object into schema
generation.

```typescript
// Multi-file spec: schemas live next to the spec on disk
await openapi({ spec: './api/openapi.yaml', refs: { external: true } })

// Also allow http(s) refs, restricted to named hosts
await openapi({
  spec: './api/openapi.yaml',
  refs: { external: true, allowHttp: true, allowedHosts: ['schemas.example.com'] },
})
```

| Option | Default | Meaning |
|---|---|---|
| `external` | `false` | Resolve any `$ref` leaving the root document |
| `allowHttp` | `false` | Also resolve `http(s)` refs (requires `external`) |
| `allowedHosts` | `[]` | Hosts an http ref may target; empty means any host |
| `timeoutMs` | `5000` | Per-request timeout for an http ref |
| `redirects` | `0` | Redirects to follow (`0` refuses them) |
| `maxBytes` | `1000000` | Maximum size of one fetched ref document, after decompression |

Loopback, link-local, private and reserved addresses are always refused, even
when they appear in `allowedHosts`. The check applies to every address a
hostname resolves to at connect time, not only to IP literals: a name such as
`127.0.0.1.nip.io`, `localtest.me` or `my-laptop.local` is refused, and so is an
allow-listed hostname that resolves to such an address. A name is refused when
any one of its addresses is. The connection is made to the address that was
checked, so DNS rebinding cannot switch it. `localhost` and `*.localhost` are
refused by name.

| Family | Refused ranges |
|---|---|
| IPv4 | `0/8`, `10/8`, `100.64/10` (CGNAT: Alibaba Cloud metadata at `100.100.100.200`, Tailscale), `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` and above (multicast, reserved, broadcast) |
| IPv6 | `::`, `::1`, `::/96`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, `100::/64`, `2001::/32` (Teredo), `2001:db8::/32`, `64:ff9b:1::/48` |
| IPv6 carrying IPv4 | IPv4-mapped (`::ffff:0:0/96`), IPv4-translated, NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses are judged by the IPv4 address they embed |

Where the refusal happens decides the error you get:

| Refused | Error |
|---|---|
| A `$ref` whose URL names a refused host or IP literal | `SchmockError` with code `OPENAPI_EXTERNAL_REF_BLOCKED`, before any request is sent |
| A hostname refused after DNS resolution, or a refused redirect hop | swagger-parser's resolver error, not a `SchmockError`; under `strict: true` it is wrapped as `OPENAPI_INVALID_SPEC` |

The resolver error carries the reason in its message:

```
Error reading file "https://schemas.example.com/pet.json": external $ref https://schemas.example.com/pet.json could not be fetched: host "schemas.example.com" resolves to 10.0.0.5, which is loopback, link-local or private
```

A refused redirect reads `external $ref redirect to <url> blocked: …`. A test
covering either case asserts on the message, not on a code.

The other limits on http refs:

- **Redirects** are followed only to `http(s)` targets. A `Location` such as
  `file:///etc/passwd` is refused with `external $ref redirect to <url> blocked:
  only http(s) redirect targets are followed`. Every hop is checked again
  against `allowedHosts` and the address block.
- **`maxBytes`** is enforced while the body streams, and counts bytes after
  gzip, deflate or br decoding, so neither a chunked body nor a small compressed
  one can exhaust memory. A breach reads `external $ref <url> returned more than
  N bytes, above the N byte limit`.
- **Timeouts and network failures** are named in the error:
  `external $ref <url> timed out after 5000ms`, or
  `external $ref <url> could not be fetched: <reason>`, where the reason is the
  network error, such as `getaddrinfo ENOTFOUND schemas.example.com`.
- **Proxies are not used.** http refs connect directly and ignore
  `HTTP_PROXY`/`HTTPS_PROXY`: a proxy resolves the name itself, which would
  defeat the address check.
- Requests are sent with `accept-encoding: gzip, deflate, br` and
  `user-agent: @schmock/openapi`.

Once `allowHttp` is on, a local file may only be referenced from a local
document. A `$ref` to a local file (a `file:` URL, or any other form
swagger-parser reads from disk) that appears only in a document fetched over
http fails with `OPENAPI_EXTERNAL_REF_BLOCKED`: `a local file may only be
referenced from a local document, never from one fetched over http`. Relative
and `../` refs between local files are unaffected.

Relative refs resolve against **the spec file's own directory**. A spec passed
as an inline object has no directory to resolve against, so a relative external
`$ref` inside one still resolves against the process working directory — pass a
file path when a spec is split across files.

External refs are Node-only: resolving them is swagger-parser's job, and it is
not in the browser build.

### How `$ref`s are read

- **Literal data is kept as data.** A `$ref` inside literal data is not
  resolved and the ref policy does not check it. Literal data is an `example`
  or `default` value, a JSON Schema `examples` array, the `value` of an OAS 3
  Example Object, Swagger 2 response `examples`, and any `x-*` vendor extension
  (for example Redocly's `x-codeSamples`). An `examples` entry that is itself a
  Reference Object still resolves.
- **OpenAPI 3.1 and later combine siblings with the target.** A `$ref` next to
  schema constraints (`properties`, `required`, `items`, `type`, `allOf`,
  `minimum` and the like) is combined with its target as an `allOf`, as JSON
  Schema 2020-12 requires. Annotation siblings (`description`, `title`,
  `example`, `default`, `readOnly`, …) override the target.
- **OpenAPI 3.0 and Swagger 2.0 let siblings override the target**, whatever
  the document order.
- **A ring of `$ref`s** that never reaches a value (`A` → `B` → `A`) fails with
  `OPENAPI_INVALID_REF` on both the Node and browser builds. A `$ref` pointing
  at its own location is allowed.

### Running in a browser

`@schmock/openapi` ships a second build for browsers, and your bundler picks it
automatically through the `browser` export condition — esbuild, Vite, webpack,
Rollup and the Angular application builder all honour it. Import
`@schmock/openapi/browser` explicitly if yours does not.

Pass the spec as an **object**. Everything that resolves `$ref`s pointing inside
that object works exactly as it does under Node, down to shared components and
circular references, which `deref-parity.test.ts` pins against the Node
implementation.

Four things need Node and throw a `SchmockError` with code `OPENAPI_NODE_ONLY`
rather than degrading quietly:

| Not available in a browser | Instead |
|---|---|
| `spec` as a file path or URL | Import or `fetch` the spec and pass the parsed object |
| `strict: true` | Validate the spec in your build or test step |
| `refs: { external: true }` | Bundle a spec whose `$ref`s all point inside itself |
| `seed` as a file path | Pass an inline array, or `{ count: n }` |

The reason is `@apidevtools/swagger-parser`, which does the file reading,
external `$ref` resolution and meta-schema validation. It is CommonJS and calls
`require("util")`, and its `json-schema-ref-parser` dependency calls
`require("path")` while declaring only `fs` in its `browser` field. Nothing a
bundler can be configured to do reaches inside a dependency's `require`, so the
browser build leaves it out entirely rather than shipping a bundle that fails to
resolve — or, worse, one that compiles and then throws `Dynamic require of
"util" is not supported` on first use.

### Server URLs and `basePath`

Swagger 2.0 `basePath` and OpenAPI 3 `servers[].url` pathnames are deliberately
**not** applied. Routes register at the path templates the spec declares, so a
spec with `basePath: /api` serves `GET /pets`, not `GET /api/pets`. Those fields
describe where a real deployment lives; where a mock is mounted is the
consumer's decision, made with the adapter's `baseUrl` option.

### Path templates

Google AIP custom methods (`/v1/jobs/{job}:cancel`) and dotted gRPC-gateway
parameters (`/v1/users/{user.id}`) are registered as the spec writes them.
`ctx.params` and `$request.path.user.id` in callbacks use the spec's parameter
name.

A template the route grammar cannot express is skipped and reported in the
parse warnings: two adjacent parameters (`/x/{a}{b}`), a double quote in a
parameter name, or a backslash right before a parameter. For example:

```
GET /x/{a}{b}: path parameters {a} and {b} are adjacent, so no request decides where one ends, skipped
```

### `strict` validates the spec itself

By default the parser is tolerant: an operation it cannot understand is skipped,
never fatal, which is what lets an incomplete work-in-progress spec drive a mock.
`strict: true` validates the document against the OpenAPI schema and
specification first and throws `OPENAPI_INVALID_SPEC` if it fails. It is
opt-in because it is both stricter and measurably slower on large specs.

Swagger 2.0 and OpenAPI 3.0.x/3.1.x are supported. Without `strict`, an object
spec with another version (for example `openapi: 3.2.0`) loads the same way
with or without `$ref`s and on both builds. With `strict: true`, any other
version fails with `OPENAPI_INVALID_SPEC`. A spec **file** with an unsupported
version fails with `OPENAPI_INVALID_SPEC` in either mode, because swagger-parser
refuses to read it; pass such a spec as an object instead.

Whatever the parser skipped is always collected either way and logged under
`debug: true`.

## CRUD Detection

The plugin analyzes path patterns to detect CRUD resources. Given a spec with `/users` and `/users/{id}`, it auto-detects a "users" resource and registers:

| Operation | Route | Behavior |
|-----------|-------|----------|
| List | `GET /users` | Returns the in-memory collection with the declared success status |
| Create | `POST /users` | Adds to collection and uses the declared success status: `201`, then `200`, then any other 2xx |
| Read | `GET /users/:id` | Finds by ID using the declared success status, or returns 404 if missing |
| Update | `PUT /users/:id` | Merges with existing using the declared success status, or returns 404 |
| Patch | `PATCH /users/:id` | Merges with existing using the declared success status, or returns 404 |
| Delete | `DELETE /users/:id` | Removes from collection and uses the declared success status (commonly 204; `200` wins when both are declared) |

Concurrent updates to one item are merged when they commit, onto the row as it
is at that moment, so two in-flight PATCHes to different fields both survive,
and each response is the row as its commit stored it. Deletes remain
last-writer-wins: a PATCH racing a DELETE of the same item answers 200 without
resurrecting it, and two concurrent DELETEs both answer 204.

**Only methods your spec declares are registered.** A spec that declares `put`
but not `patch` on the item path serves `PUT /users/:id` and answers
`PATCH /users/:id` with a 404 `ROUTE_NOT_FOUND` — the plugin no longer
synthesizes the other verb. When both are declared, each keeps its own response
contract: its own status, its own response schema, its own declared response
headers and its own error schemas.

Non-CRUD routes (e.g., `GET /health`, `POST /auth/login`) get schema-generated static responses.

**Lone item reads.** A group that declares only `GET /things/{id}`, with nothing
on the collection path and no other item method, is a lookup. When its scope has
been seeded (or pre-loaded through `schmock({ state })`), it serves stored rows
by id and answers 404 for any other id. Otherwise it answers from the declared
response schema, like a static route.

A resource is named after the last literal segment of its collection path. When
that path ends in a parameter (`/repos/{owner}/{repo}` is grouped under
`/repos/{owner}`), the parameter is skipped, so seed and `resources` keys use
`repos`, not `:owner`. As with `/users` and `/admins/users`, two resources can
share a name and then share its seed entry.

Earlier releases named such a group after the parameter (`:owner`). A `seed`
or `resources` key that still uses the old name no longer applies silently: it
throws `OPENAPI_UNKNOWN_SEED_RESOURCE` or `OPENAPI_UNKNOWN_RESOURCE_OVERRIDE`,
and the message names the key to use.

### Identifiers

The plugin picks one **id property** per resource, resolved once from the item
schema:

1. the path parameter's name (`petId`) when the item schema declares a property
   with that name;
2. otherwise `id`, when the schema declares it;
3. otherwise the path parameter's name — so a spec with no item schema keeps the
   historical behaviour.

Routing is untouched: the lookup *value* always comes from the path parameter
(`GET /bookings/{bookingId}` still reads `bookingId`), only the stored and
emitted property *name* follows the resolved id property. A spec whose `Booking`
declares `id` therefore stores and returns `id`, never `bookingId`.

The identifier is always **server-assigned**: a client-supplied value for it is
overwritten on create. Its shape follows the declared type of that property:

| Declared type | Minted value |
|---------------|--------------|
| `integer` / `number` / undeclared | `1`, `2`, `3`, … |
| `string` | `"1"`, `"2"`, `"3"`, … |
| `string` with `format: uuid` | `00000000-0000-4000-8000-000000000001`, … |

UUIDs are synthetic rather than random on purpose: `format: uuid` is enforced
when `validateResponses` is on, and a `fakerSeed` run has to stay reproducible.

Seed rows written with the old path-parameter key (`{ planetId: 1, … }`) are
rewritten onto the resolved id property when the collection is seeded, and the
id counter continues past the highest seeded id.

### Created bodies satisfy the declared contract

When the create operation declares a response schema, the created body is
**generated from that contract** and the request body is then overlaid on top:

- a declared property supplied by the request keeps the request's value, unless
  the schema marks it `readOnly`;
- a property marked `readOnly` (for example `createdAt`) is server-assigned: a
  value the request supplies is ignored. Create keeps the generated value, and
  PUT/PATCH keep the stored one;
- a property marked `writeOnly` (a password, a card cvc) is accepted in the
  request but never stored or returned by create, PUT or PATCH, on open
  contracts as well as closed ones;
- a declared property the request omits keeps its generated value, so `required`
  and `format` constraints hold;
- an **undeclared** request field is copied through, unless the contract sets
  `additionalProperties: false` — then it is dropped;
- the id property always wins over both the generated and the client value.

The **resource** that is returned is the resource that is stored, so read, list
and update stay consistent with create. When the create response wraps the
resource in an envelope (for example `{ data: <Resource> }`), the bare resource
is what gets stored — so `GET /widgets/{id}` replays a resource — and only the
returned body is wrapped in the declared envelope. When the operation declares no
response schema (or a non-object one), create falls back to echoing the request
body and stamping the id.

When the create response declares several media types, the contract is chosen by
negotiating the request's `Accept` header against them, falling back to the first
declared type.

> **Generation cost on wide schemas.** A create generates the whole declared
> response contract on every request, and `@schmock/faker` fills in every
> optional property. For a very wide create-response schema (hundreds of
> optional fields) a single `POST` can take seconds and return a large body. To
> opt out per request, return a trimmed schema from `onSchema` for the create
> method — an empty schema (`{}`) reduces the response to the echoed request
> body plus the id.

### List envelopes

A list operation whose response is an object carries the collection in one of
its array properties. The envelope may be typed (`type: object`) or untyped
(`properties` with no `type`), may be composed through `allOf`, and may nest the
array one level down (`{ page: { items: [...] } }`, HAL
`{ _embedded: { pets: [...] } }`).

When an envelope declares several arrays (`errors`, `links`, `warnings` next to
the items), the collection goes into the first one that wins, in order:

1. the array whose items declare the resource's id property;
2. the array sharing the most properties with the item GET's schema;
3. an array of objects over an array of primitives;
4. a conventional name: `data`, `items`, `results`, `result`, `content`,
   `value`, `values`, `records`, `entries`, `list`;
5. the top level over a nested level;
6. declaration order.

A nested array is only considered when it has an id, shared properties, or an
envelope parent key (`_embedded`, `embedded`, `page`, `data`, `result`,
`results`, `response`, `payload`). The same array supplies the resource schema
used for seeds. The collection array is also found when composition makes it
nullable (`anyOf: [{ type: array }, { type: null }]`, or 3.0 `allOf` with
`nullable: true`), when it is a `oneOf` of array or object, and when it is
`{ type: array }` without `items`. The envelope keeps its declared key order.

A list operation whose success schema is an object with no array (for example
`GET /settings` next to `POST /settings`) answers with a body generated from
that schema instead of a bare array. When that object cannot be generated, the
route serves the bare collection and logs a warning instead of answering 500.

### Collection scoping

Each CRUD resource keeps its own collection, keyed by the resource's **full
collection path** rather than its last path segment. `/users` and
`/admins/users` are therefore independent collections even though both are named
`users`.

A nested collection gets one collection per parent id: with
`/owners/{ownerId}/pets`, a pet created under `POST /owners/1/pets` is not listed
by `GET /owners/2/pets`, and `GET /owners/2/pets/{id}` answers 404 for it. Id
counters restart per scope, so two owners can each hold a pet with id `1`.

> **Written scopes are not evicted.** A read no longer allocates: `GET`s across
> any number of parent ids on a resource with no seed data leave the state object
> empty, so scanning `/owners/<random>/pets` costs nothing. A scope is
> materialized when it is first seeded, or by a `POST` to it (which allocates
> its id counter eagerly, so even a rejected create leaves that one key behind).
> From then on it lives for the lifetime of the mock instance — there is no cap
> and no eviction,
> because evicting a written scope would silently delete data a `POST` created.
> A long-running server that writes across a very large or attacker-controlled
> range of parent ids will still grow state unboundedly; construct a fresh mock
> per test, or `reset()` between suites, to reclaim it.

### Transactional mutations

Create, update and delete stage their write and apply it only once the plugin
knows the final response status. If the response the plugin returns is 400 or
above, the write is discarded:

- `Prefer: code=400` on a `POST` returns the declared 400 **and stores nothing**.
- Any `Prefer` directive that takes effect (`code=N` naming a declared status,
  `example=name` naming a found example, or `dynamic`) makes the request a
  simulation. The response comes from the schema or the example, and the staged
  create, update or delete is discarded, even for a 2xx such as
  `Prefer: code=201` on a `POST`. A `Prefer` header with no mock directive, such
  as `return=representation`, does not count, and the write commits as usual. A
  simulated create still burns an id, and callbacks still fire with the
  simulated body.
- An `Accept` a `PUT` response cannot satisfy returns 406 and leaves the stored
  item unchanged.
- A `validateResponses: true` failure returns 500 and leaves the collection
  unchanged.

Ids are still allocated eagerly, so a rejected create burns an id: the sequence
can have gaps, but never duplicates. Plugins that run *after* `@schmock/openapi`
in the pipe see the mutation already committed, and a 4xx/5xx response or a
throw from such a plugin does **not** roll the write back. Use openapi's own
`validateResponses` rather than a validation plugin piped after it, or keep
openapi the last response-altering plugin.

### Methods a CRUD resource cannot serve

Any method declared inside a CRUD group that the CRUD generators cannot serve is
registered as a plain schema-generated route rather than being dropped. That
covers `HEAD` and `OPTIONS`, a `POST` on an item path, a collection-level `PUT`,
and an item path whose parameter name differs from the resource's own id
parameter (e.g. `PUT /users/{id}` alongside `GET /users/{userId}`).

Two notes on how that fallback reaches the wire:

- **`HEAD` responses are generated with a body, then stripped.** The route is
  served by the same static generator as `GET`, so the body is generated; response
  normalization drops it before any adapter sees it, leaving the status and
  headers (including a declared `Content-Length`) intact.
- **A declared `OPTIONS` operation and CORS preflight coexist.** Under the CLI's
  `--cors`, only a real browser preflight — `OPTIONS` carrying both `Origin` and
  `Access-Control-Request-Method` — is answered by the transport with `204`.
  Every other `OPTIONS` reaches the mock, so a spec-declared `options` operation
  answers it and an unrouted path still answers `404`. The Express adapter does
  no CORS handling at all: mount your own preflight middleware in front of it if
  you need one.

### Route ownership

The plugin only inspects routes it registered from its own spec. Routes you
register manually on the same instance, and routes registered by a *different*
`openapi()` plugin piped onto the same mock, pass through untouched: no security
check, no content negotiation, no request/response validation, no `Prefer`
handling and no callback dispatch. This means a spec with global `security` can
be piped onto an instance that also serves manual routes without those routes
starting to answer 401.

## Seed Data

Pre-populate CRUD resources so list/read operations return data immediately:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  seed: {
    // Inline array — rows carry the resource's id (see Identifiers)
    users: [
      { userId: 1, name: 'Alice', email: 'alice@example.com' },
      { userId: 2, name: 'Bob', email: 'bob@example.com' },
    ],

    // Auto-generate from schema
    posts: { count: 50 },

    // Load from file
    products: './fixtures/products.json',
  },
}))
```

Seed rows are keyed by the resource's id property, resolved as described in
[Identifiers](#identifiers): the path parameter's name when the item schema
declares it, otherwise `id`. A row keyed by the path parameter's name instead
(`userId` for `/users/{userId}`) is rewritten onto the id property, so with a
`User` that declares `id`, the row above is stored and returned as `{ id: 1, … }`.

Seed keys must name a detected CRUD resource. An unknown key (a typo such as
`adresses`) throws `SchmockError` code `OPENAPI_UNKNOWN_SEED_RESOURCE` at
`openapi()` time, before any seed file is read. The message lists the detected
resources, and `error.context` is `{ key, resources }`. Other shapes are
rejected with `OPENAPI_INVALID_OPTION`:

- a `seed` that is not an object (`seed: 42`). The message points at
  `fakerSeed`: openapi's RNG seed is `fakerSeed`, while `@schmock/faker` calls
  it `seed`;
- an entry that is not an array, a file path or `{ count: n }` (for example
  `{ counts: 3 }`), with context `{ option: 'seed', resource }`.

Seed loading runs after those checks and raises the same code, with context
`{ option: 'seed', resource, file? }` (`file` for the two seed-file cases), for:

- a seed file that is not valid JSON;
- a seed file that does not contain a JSON array;
- a `{ count }` that is not a non-negative integer;
- a `{ count }` for a resource whose spec has no schema to generate from.

These four used to be plain `Error`s; the messages are unchanged, and
`openapi()` rejects with the error.

`seed: null` is treated as no seed.

**Known limitation — seed entries are keyed by resource name, collections by
path.** Collections are scoped by their full path (see [Collection
scoping](#collection-scoping)), but a seed key still matches on the resource's
name. A spec with both `/users` and `/admins/users` therefore gets two
independent collections that both draw from the same `users` seed entry, and a
`{ count: n }` entry is generated from the first matching resource's schema.
Per-path seed targeting is not supported yet.

### Seed budgets

Seeding is bounded so a stray `{ count: 5_000_000 }` or a runaway fixture fails
fast instead of exhausting memory. Every breach throws a `ResourceLimitError`
at **plugin construction** (`await openapi({...})` rejects), not per request.

| Limit | Value | Applies to |
|---|---|---|
| `MAX_SEED_ITEMS_PER_RESOURCE` | 10 000 | one resource's inline array, seed file, or `{ count }` |
| `MAX_SEED_ITEMS_TOTAL` | 50 000 | all resources in one `seed` config |
| `MAX_SEED_FILE_BYTES` | 5 MiB | one seed JSON file, measured before it is read |
| `MAX_SEED_GENERATED_NODES` | 1 000 000 | JSON nodes produced by `{ count }` generation |
| `MAX_SEED_MANIFEST_BYTES` | 1 MiB | a CLI `--seed` manifest |

The constants are exported from `@schmock/openapi` for assertions, and are
deliberately not configurable through `OpenApiOptions` — the configuration
being bounded should not be able to remove the bound.

## Prefer Header

The `Prefer` header lets clients control responses at request time:

### `Prefer: code=N` — Force a specific status code

```typescript
const res = await mock.handle('POST', '/users', {
  body: { name: 'Alice' },
  headers: { prefer: 'code=201' },
})
// Returns the 201 response schema from the spec. Nothing is stored: a Prefer
// response is a simulation (see Transactional mutations).
```

### `Prefer: dynamic=true` — Regenerate from schema

```typescript
const res = await mock.handle('GET', '/users', {
  headers: { prefer: 'dynamic=true' },
})
// Generates fresh fake data from the response schema every time
```

On a CRUD create it keeps the create's status (201 when declared).

### `Prefer: example=name` — Return a named example

```typescript
const res = await mock.handle('GET', '/users', {
  headers: { prefer: 'example=admin-user' },
})
// Returns the "admin-user" example from the spec
```

### Parsing

The header follows RFC 7240. Directives are comma-separated and several may be
combined (`code=404, example=dog`). Names are case-insensitive (`CODE=404`), and
whitespace around `=` is allowed. Values may be quoted (`example="fluffy"`), and
a comma or semicolon inside quotes is part of the value. `;`-parameters after a
value are ignored (`example=fluffy; foo`). The example name itself is
case-sensitive. `dynamic` may be written bare or as `dynamic=true` (any case).

Precedence is `code`, then `example`, then `dynamic`. An unknown status or
example name falls through to the next directive, or to the normal response.

## Security Validation

When `security: true`, the plugin enforces security schemes defined in the spec:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  security: true,
}))

// Missing auth → 401
const res = await mock.handle('GET', '/protected-resource')
// → { status: 401, body: { error: 'Unauthorized', code: 'UNAUTHORIZED' } }

// With auth → success
const res = await mock.handle('GET', '/protected-resource', {
  headers: { authorization: 'Bearer my-token' },
})
```

Supported schemes: Bearer, Basic, API Key (header, query, or cookie), OAuth2,
and OpenID Connect. Security simulation verifies that credentials are present;
it does not authenticate their value. An operation-level `security: []`
explicitly overrides global security and makes that operation public.

## Content Negotiation

The plugin validates `Accept` against the content types declared for the
selected response status. A media type that exists only on another status does
not make it acceptable. Schema generation uses the negotiated media-type entry,
so the response body and `Content-Type` cannot silently diverge:

```typescript
const res = await mock.handle('GET', '/users', {
  headers: { accept: 'text/xml' },
})
// → { status: 406, body: { error: 'Not Acceptable', acceptable: ['application/json'] } }
```

Swagger 2.0 `produces` supplies those content types, operation level overriding
root level. A Swagger 2.0 spec that declares `produces` therefore negotiates and
sets `Content-Type` where it previously did neither.

Each declared representation is scored by the **most specific** `Accept` range
that matches it: exact type, then `type/*`, then `*/*`; within the same range,
more matching media parameters are more specific. A `q=0` exclusion is therefore
never re-admitted by a broader range. `Accept: */*;q=1, application/json;q=0`
against a route declaring JSON and XML answers XML, and answers 406 when JSON is
all the route declares. A concrete candidate is first assigned to its most
specific declared content key, so `application/json` wins over an earlier
`application/*`; only equally specific declarations use spec order.

Every parameter except `q` is a media parameter and must match the declared
representation. The position of `q` does not change that rule:
`application/json;q=0;profile=b` excludes only profile `b`, just like
`application/json;profile=b;q=0`. Parameter names are case-insensitive;
`charset` values are also compared case-insensitively, while values of other
parameters (for example `profile`) remain case-sensitive. A bare
`application/json` range still matches parameterized JSON representations.

The selected concrete declaration keeps its raw OpenAPI key on the wire, so a
key such as `application/json;profile=b` retains its parameters and response
validation selects that profile's schema. OpenAPI content keys can themselves be
media ranges: `application/*` with `Accept: application/problem+json` emits the
concrete `application/problem+json`, never `application/*`. With no `Accept`, a
wildcard response uses a concrete JSON default (`application/json`). A wildcard
client range is concretized too: `*/*` with `Accept: image/*` emits `image/png`,
retaining media parameters from both sides.

## Request Validation

Validate request bodies against the spec's `requestBody` schema:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  validateRequests: true,
}))

const res = await mock.handle('POST', '/users', {
  body: { invalid: 'data' },
})
// → { status: 400, body: { error: 'Request validation failed', code: 'VALIDATION_ERROR', details: [...] } }
```

Request validation and security run before route generators, so rejected CRUD
requests cannot mutate their collections. A missing body is rejected when the
OpenAPI operation declares `requestBody.required: true`.

A `requestBody` schema of `type: string, format: binary` accepts `ArrayBuffer`,
typed-array and `Blob` bodies, which is how every transport delivers raw
uploads.

### Per-media-type request schemas and 415

Each media type an operation declares keeps its own schema, and the request's
`Content-Type` selects which one applies. Declaring a type the operation does
not accept is answered with 415:

```typescript
const res = await mock.handle('POST', '/users', {
  body: { name: 'Ada' },
  headers: { 'content-type': 'text/csv' },
})
// → { status: 415, body: { code: 'UNSUPPORTED_MEDIA_TYPE', supported: ['application/json', 'application/xml'] } }
```

Wildcard keys (`application/*`, `*/*`) are honored and media type parameters
such as `; charset=utf-8` are ignored when matching. A request that sends **no**
`Content-Type` is not rejected — it validates against the JSON-ish default
schema, the same contract used before per-media-type schemas existed.

415 rides on `validateRequests`, like 400 does: without it the plugin does not
police request contracts at all.

Swagger 2.0 declares its accepted media types with `consumes` (operation level
overriding root level); an operation that declares none accepts anything.

## Response Validation

With `validateResponses: true`, the final OpenAPI response is validated against
the schema selected by its actual status code and negotiated media type. An
explicit response `Content-Type` keeps all of its parameters when selecting the
declared content entry, so profile-specific schemas do not collapse onto the
first parameter-free media type. The same generated header selects the body
schema before `Accept` or the default on both static and CRUD routes, preventing
the body and its media label from diverging. A mismatch becomes a structured
500 response with code `RESPONSE_VALIDATION_ERROR`.
Response definitions are resolved in OpenAPI order: exact status, status-class
wildcard such as `2XX`, then `default`. Schema-less statuses are still honored;
for example, an operation declaring only `201` returns 201, and a declared `204`
has no body.

## Response Headers

Response headers declared on the selected response are generated and returned,
on both auto-detected CRUD routes and plain (non-CRUD) routes. Values come from
the header schema:

- an `enum` uses its first non-null value;
- a scalar `default` is used verbatim (an object or array default is ignored);
- `format: uuid` and `format: date-time` are generated;
- `integer` and `number` fall back to `0`, or to the nearest whole number inside
  `minimum`/`exclusiveMinimum`/`maximum`/`exclusiveMaximum` when those exclude
  `0` (the midpoint of a fractional `number` range);
- `string` falls back to `minLength` characters (empty by default);
- `boolean` falls back to `false`.

Nullable header schemas (3.0 `nullable: true`, 3.1 `type: [T, "null"]`) emit
the placeholder of their non-null type. A header whose schema yields nothing is
omitted — `array`, `object` and untyped header schemas are dropped deliberately,
since there is no single obvious wire form for them.

Header values obey `fakerSeed` too: see
[Deterministic Generation](#deterministic-generation) for the fixed-clock trade
a seeded `format: date-time` header makes.

Headers always come from the same response entry the status does. An operation
declaring only `404` therefore answers 404 *with the 404 entry's headers* (see
[Operations with no 2xx response](#operations-with-no-2xx-response)). Only an
operation that declares no responses at all falls back to a bare `200 {}` with
no headers. CRUD error responses (404 / 400 / 409) deliberately do not emit
declared response headers.

## Operations with no 2xx response

A plain (non-CRUD) operation answers with its **declared** status:

- a declared success status when one exists (`200`, `201`, any other `2xx`,
  then `2XX`, then `default`);
- otherwise the **lowest declared status**, taking a range key at its effective
  value — `{"4XX", 503}` answers 400, not 503.

So an operation declaring only `404` and `503` answers `404` with a body
generated from the 404 schema. Previously it answered an undeclared `200 {}`.
Content negotiation preflights the same status, and a bare
`404: { description }` with no `content` simply skips negotiation rather than
returning 406.

Auto-detected **CRUD** routes keep the old rule on purpose: they use the
declared success status or their operation default (201 for create, 204 for
delete). A `POST` that declares only `400` must not answer 400 with a created
item. A create prefers `201`, then `200`, then any other 2xx, so a create
declaring both `201` and `200` answers `201`. Other operations keep the order
above, `200` first; a delete declaring both `200` and `204` answers `200`.

## Examples and Nullable Schemas

A schema-level `example` becomes the generation default only for a scalar value
on a scalar schema, so a property declaring `example: "active"` is returned as
`"active"` rather than a value guessed from its name. An object or array
`example`, on a component or on a property, is not returned verbatim: bodies
and seed rows are generated from the schema, so required properties hold,
seeded rows differ, and a `writeOnly` field present in the example never
reaches a response. Set an explicit `default` to pin an object value.
Media-type examples for `Prefer: example=` are unaffected.

A nullable value is `null` about 5% of the time, whether the schema uses 3.0
`nullable: true` or the 3.1 forms `type: [T, "null"]` and
`oneOf: [{ $ref }, { type: "null" }]`. A 3.0 `nullable: true` on a schema with
an `enum` or `const` and no `type` accepts `null`: `null` is appended to the
enum, and `const: x` becomes `enum: [x, null]`.

## Generation Failures

When a response schema cannot be generated from — an empty schema, an array
with no `items`, an unsupported `type`, an empty `enum` or `anyOf`, a nesting
or size limit — the request now fails with a **structured 500** rather than a
laundered `200 {}`:

```json
{ "error": "Schema generation failed for route GET /items: …", "code": "SCHEMA_GENERATION_ERROR" }
```

The `code` depends on where generation gave up. A failure raised by the
generator itself keeps its own code (for example `SCHEMA_VALIDATION_ERROR` for
an unsupported `type`, or `RESOURCE_LIMIT_ERROR` for a nesting-depth breach);
anything else is wrapped as `SCHEMA_GENERATION_ERROR` with the route in the
message. Assert on the presence of `code`, not on one specific value.

Two deliberate exceptions:

- **`Prefer: dynamic=true`** regenerates inside the plugin's `process` hook, so
  the pipeline wraps the throw and the wire code is `PLUGIN_ERROR`, with the
  original `Schema generation failed for route …` text preserved in `error`.
  Unifying the code would require an error hook that changes unrelated pipeline
  behaviour.
- **List wrappers** degrade instead of failing. Only the wrapper's decoration
  (`has_more`, `object`, …) is generated: the array property is removed first,
  so a tall item schema cannot push the wrapper over faker's nesting limit, and
  the live collection is injected afterwards. A failure there still returns the
  real items under the declared wrapper key and logs a warning. A list whose
  object contract declares no array is generated like a static route and fails
  the same way (structured 500).

## OpenAPI Callbacks

Callbacks never perform implicit network requests. They are disabled by
default and require an application-owned dispatcher:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  callbacks: {
    dispatch: async ({ url, method, headers, body }) => {
      await callbackQueue.publish({ url, method, headers, body })
    },
  },
}))
```

The dispatcher runs only after request and response validation succeed. The
application therefore controls whether delivery uses an in-memory queue, a
test spy, or an explicitly secured network client.

Callback runtime expressions support RFC 6901 JSON Pointers, including array
indices and escaped `~0`/`~1` tokens, for request and response bodies.

URL expressions resolve `$request.body#/…`, `$request.header.<name>` (matched
case-insensitively), `$request.query.<name>`, `$request.path.<name>` and
`$response.body#/…`. Numbers and booleans are stringified, so
`{$response.body#/id}` works with integer CRUD ids. If any of these expressions
resolves to nothing usable (missing, `null`, an object or an array), the
callback is skipped rather than sent to a partial URL. The skip is logged with
`console.warn` only when `debug: true`, because the usual cause is a client that
sent no `callbackUrl`. `$url`, `$method` and `$statusCode` are not implemented
and resolve to an empty string.

`$response.body#/…` and the fallback payload below read the body the client
actually receives. A `{ status, body, headers }` object is unwrapped only when
`headers` is absent or a record of strings, the rule core applies. Otherwise
core delivers the whole object as the body, so `{$response.body#/id}` resolves
against that object: a generator returning
`{ status: 201, body: { id: 1 }, headers: { 'x-n': 1 } }` answers 200 with the
whole object, `#/body/id` resolves to `1`, and `#/id` is unresolved, which skips
the callback.

The dispatched payload is generated from the **callback operation's own declared
request body**, using `fakerSeed` when one is configured, so the webhook your
application receives matches the contract the spec declares for it. Only when
the callback declares no request body does the payload fall back to the primary
endpoint's response body. The dispatched `content-type` is always
`application/json` — the parser extracts JSON callback bodies only. Generated
callback bodies are not re-validated, since they are produced from the schema.
If generation fails, the failure is logged and that one callback is skipped;
other callbacks on the same operation still dispatch.

## Schema Patching

### `schemas` option — Replace schemas when the plugin is built

When a spec has missing or incomplete schemas, provide replacements keyed by `"METHOD /path"` or `"METHOD /path STATUS"`:

```typescript
mock.pipe(await openapi({
  spec: './incomplete-api.yaml',
  schemas: {
    // Replace the 200 response schema for GET /items
    'GET /items': {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          price: { type: 'number' },
        },
      },
    },

    // Target a specific status code
    'POST /items 201': {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        created_at: { type: 'string', format: 'date-time' },
      },
    },
  },
}))
```

Without a status code, the schema replaces the first 2xx response. If no 2xx response exists, a 200 entry is created.

**Every key is validated, and a bad one throws.** The grammar is exactly
`"METHOD /path"` or `"METHOD /path STATUS"`: an uppercase, supported HTTP
method, one space, a path with a leading slash, and optionally one more space
and a 3-digit status in `100`–`599`. `openapi()` rejects anything else with
`OPENAPI_INVALID_SCHEMA_OVERRIDE`, naming the offending key — including a
well-formed key naming a route the spec does not declare.

A path parameter may be written either way: the spec's own `{petId}` or the
Express `:petId` the router uses. Both resolve to the same operation. The
parameter **name** is part of the route key, though — `GET /pets/{id}` does not
match an operation declared as `/pets/{petId}`.

Literal colons and unusual parameter names are spelled out in the Express form:
`{job}:cancel` becomes `:job\:cancel`, `/jobs:batchGet` becomes
`/jobs\:batchGet`, `{user.id}` becomes `:"user.id"`, and `{x}_{y}` becomes
`:"x"_:y`. An override key may use the spec spelling
(`POST /v1/jobs/{job}:cancel`) or that escaped Express spelling.

| Key | Verdict |
|-----|---------|
| `GET /items` | valid |
| `POST /items 201` | valid |
| `GET /pets/{petId}` | valid — the spec's own spelling |
| `GET /pets/:petId` | valid — the same operation, Express spelling |
| `POST /v1/jobs/{job}:cancel` | valid — the spec's spelling of a custom method |
| `POST /v1/jobs/:job\:cancel` | valid — the same operation, Express spelling |
| `get /items` | throws — method must be uppercase |
| `GET/items` | throws — missing space |
| `GET items` | throws — path needs a leading slash |
| `GET /items 2xx` | throws — status must be 3 digits |
| `GET /items 200 extra` | throws — trailing tokens |
| `GET /nope` | throws — no such operation in the spec |
| `GET /pets/{id}` | throws — parameter name must match the spec's |

> **Upgrade note.** A malformed or unmatched key used to be silently ignored,
> so a typo produced a mock that quietly served the unpatched contract.
> Those keys now fail fast at `openapi()`. `"GET /items 2xx"` was the worst
> case: `parseInt("2xx")` is `2`, which injected a phantom `responses[2]` entry
> that could win status selection and leak the status tuple into the body.

The user schema **replaces** the parsed schema entirely (no deep merge).
Overrides are applied while `openapi()` builds the plugin — *before* CRUD
detection and before seed data is generated — so CRUD metadata, `{ count: n }`
seed items and static routes all see the replacement. Piping one plugin object
into several mocks applies it once; the patch is idempotent.

An override key names no media type, so it is read as a replacement for the
JSON-ish contract: on an operation declaring both `application/json` and
`application/xml`, only the JSON branch is rewritten. An operation declaring a
single non-JSON media type is still patched, since there is no ambiguity about
which contract was meant.

### `onSchema` callback — Modify schemas per request

For dynamic schema modification based on request context:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  onSchema: (schema, context) => {
    // Add properties to empty schemas
    if (!schema.properties && context.path === '/items') {
      return {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
        },
      }
    }

    // Return undefined to keep the original schema
  },
}))
```

The callback receives the schema and a context object with `method`, `path`, `params`, `query`, and `headers`. It works with static responses, Prefer header-driven dynamic generation, and CRUD routes.

`context.path` is always the operation's template path in Express form
(`/pets/:id`), never the concrete request path. The context always has exactly
those five fields, including under `Prefer`-driven regeneration. Under
`Prefer: dynamic=true` on a static route the hook runs twice: once for the
default body and once for the regenerated one.

On CRUD routes the callback fires exactly where a body is generated:

| Site | Fires |
|------|-------|
| Create response contract | yes |
| List wrapper skeleton | yes |
| CRUD error bodies (404/400/409) | yes |
| Read / update / delete success bodies | **no** |

Read, update and delete replay items from stored state instead of generating
them, so nothing is passed to the callback on their success path — they only
reach it when they answer 404.

**Use cases:**
- Fill gaps in incomplete specs
- Return different schemas based on query parameters
- Add fields that the spec doesn't define
- Test schema evolution scenarios

## Resource Overrides

Override CRUD detection decisions per resource:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  resources: {
    users: {
      listWrapProperty: 'data',      // list response wraps items in { data: [...] }
      errorSchema: {                  // custom error response format
        type: 'object',
        properties: {
          message: { type: 'string' },
          status: { type: 'integer' },
        },
      },
    },
    posts: {
      listFlat: true,                 // force flat array response (no wrapper)
    },
  },
}))
```

`listWrapProperty` and `listFlat` describe one list shape, so they also discard
the operation's per-media-type response contracts: an overridden list answers
with the overridden shape regardless of the negotiated `Accept`.

`listWrapProperty` takes its item schema from the named property when the spec
declares it as an array, otherwise from the resource schema (a flat list keeps
its own items). It does not change the resource schema that seeds and create
use.

## Deterministic Generation

Use `fakerSeed` for reproducible data:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  fakerSeed: 42,
}))

// Same seed → same data every time
```

The seed covers **response headers** as well as bodies. The contract is *same
seed + same request sequence within a mock instance → same values*. One ordinal
is reserved when a header-producing request starts, before asynchronous body
generation, and is shared by that response's generated headers. Completion
order therefore cannot change IDs. CRUD and static routes from one OpenAPI
installation share the sequence, while separately built mocks restart it and
replay the same request sequence. A constant `X-Request-Id` would not be an id
at all.

> **A seeded `date-time` header runs on a fixed clock.** Under `fakerSeed`, a
> header like `X-Served-At` no longer tracks wall time; it is derived from the
> seed and the request ordinal. That is the only way "seeded" and "timestamp"
> can coexist, and it is the same trade the seeded body path already makes.
> Unseeded runs are unaffected: they keep a random v4 uuid and the real clock.

## Real-World Examples

### Frontend Development

Mock your backend API while the real one is under development:

```typescript
const mock = schmock({ state: {} })
mock.pipe(await openapi({
  spec: './api/openapi.yaml',
  seed: {
    users: { count: 20 },
    products: './fixtures/products.json',
  },
  security: true,
  fakerSeed: 1,
}))

const server = await mock.listen(4000)
// Point your frontend at http://localhost:4000
```

### Integration Testing

```typescript
import { describe, it, expect, beforeAll } from 'vitest'

let mock: Schmock.CallableMockInstance

beforeAll(async () => {
  mock = schmock({ state: {} })
  mock.pipe(await openapi({
    spec: './openapi.yaml',
    seed: { users: [{ userId: 1, name: 'Test User' }] },
    validateRequests: true,
    security: true,
  }))
})

it('rejects unauthenticated requests', async () => {
  const res = await mock.handle('GET', '/users')
  expect(res.status).toBe(401)
})

it('returns seeded data with valid auth', async () => {
  const res = await mock.handle('GET', '/users', {
    headers: { authorization: 'Bearer test-token' },
  })
  expect(res.status).toBe(200)
  expect(res.body).toHaveLength(1)
  expect(res.body[0].name).toBe('Test User')
})

it('validates request bodies', async () => {
  const res = await mock.handle('POST', '/users', {
    body: {},
    headers: { authorization: 'Bearer test-token' },
  })
  expect(res.status).toBe(400)
  expect(res.body.code).toBe('VALIDATION_ERROR')
})
```

### CLI Server for QA

```sh
schmock ./api.yaml --port 8080 --cors --seed ./qa-data.json
```

See the [CLI guide](./cli.md) for more details.

## Debug Mode

Enable `debug: true` to see CRUD detection decisions:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  debug: true,
}))
```

Output:
```
[@schmock/openapi] Detected 3 CRUD resources, 2 static routes
[@schmock/openapi] users: list=wrapped("data"), error=schema(404), headers=0
[@schmock/openapi] posts: list=flat, error=default, headers=0
[@schmock/openapi] tags: list=flat, error=default, headers=0
```

A nested list wrapper shows its full path, for example `list=wrapped("page.items")`
(see [List envelopes](#list-envelopes)).
