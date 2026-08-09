# Schmock

> Schema-driven mock API generator with direct callable API and plugin pipeline

## Project Vision
A lightweight, framework-agnostic tool that provides immediate callable mock APIs with zero boilerplate, enhanced through an extensible plugin pipeline architecture.

## Core Philosophy
- **Direct callable API**: No build() needed - define and use immediately
- **Zero boilerplate**: Get running in under 30 seconds
- **Plugin pipeline**: Extensible `.pipe()` architecture for advanced features
- **Framework agnostic**: Works everywhere JavaScript runs
- **Type safe**: First-class TypeScript support with ambient types

## Architecture

### Packages

| Package | Description |
|---------|-------------|
| `@schmock/core` | Core callable API with plugin pipeline |
| `@schmock/faker` | Faker-powered automatic data generation plugin |
| `@schmock/express` | Express middleware adapter |
| `@schmock/angular` | Angular HTTP interceptor adapter |
| `@schmock/validation` | Request/response JSON Schema validation plugin |
| `@schmock/query` | Pagination, filtering, sorting plugin |
| `@schmock/openapi` | OpenAPI/Swagger auto-mock generation plugin |
| `@schmock/cli` | Standalone CLI server from OpenAPI specs |
| `@schmock/react` | React provider, hook, and testing utilities |
| `@schmock/vue` | Vue plugin and composable |
| `@schmock/schmock` | Aggregate package for Core, non-framework plugins, and CLI |

### Package Structure
```
schmock/
├── packages/
│   ├── core/           # Core callable API with plugin pipeline
│   ├── faker/          # Faker-powered data generation plugin
│   ├── express/        # Express middleware adapter
│   ├── angular/        # Angular HTTP interceptor adapter
│   ├── validation/     # Request/response validation plugin
│   ├── query/          # Pagination, filtering, sorting plugin
│   ├── openapi/        # OpenAPI/Swagger auto-mock generation plugin
│   ├── cli/            # Standalone CLI server
│   ├── react/          # React provider, hook, and testing utilities
│   ├── vue/            # Vue plugin and composable
│   └── schmock/        # Core + non-framework plugins + CLI aggregate
├── features/           # BDD test specifications
├── docs/               # API documentation
└── benchmarks/         # Performance benchmarks
```

## Development Status

The product milestones below predate the production-hardening phases tracked in
[`CODEBASE-ANALYSIS.md`](../CODEBASE-ANALYSIS.md). They describe product scope,
not the audit remediation sequence.

### Product Phase 1 — Complete
- **Core callable API**: Direct mock instance creation and usage
- **Plugin pipeline**: `.pipe()` chaining architecture
- **Route handling**: All HTTP methods with path parameters
- **State management**: Shared mutable state between requests
- **Express adapter**: Full middleware integration
- **Angular adapter**: HTTP interceptor implementation
- **Faker plugin**: JSON Schema-based data generation with faker.js
- **TypeScript support**: Full type safety with ambient types
- **BDD testing**: Comprehensive test coverage with vitest-cucumber
- **CI/CD**: GitHub Actions workflows
- **Monorepo setup**: Bun workspaces with proper dependencies
- **Developer experience**: Debug mode, auto content-type detection, delay simulation

### Product Phase 2 — Complete
The original request-history, lifecycle, validation, query, and performance
milestone is complete:

#### 2.1 Request Spy / History API
Full request assertion capabilities implemented:
- `mock.history()` — all recorded requests
- `mock.history('GET', '/users')` — filtered by method + path
- `mock.called()` / `mock.called('POST', '/users')` — boolean assertions
- `mock.callCount()` / `mock.callCount('GET', '/users')` — count assertions
- `mock.lastRequest()` / `mock.lastRequest('POST', '/users')` — most recent request
- `RequestRecord` type with method, path, params, query, headers, body, timestamp, response

#### 2.2 Mock Reset / Lifecycle
Clean test isolation between test cases:
- `mock.reset()` — clear all routes, state, and history
- `mock.resetHistory()` — clear only request history
- `mock.resetState()` — clear only state, keep routes

#### 2.3 Validation Plugin
JSON Schema validation for API contract enforcement:
- Request body validation
- Response body validation
- Header validation (required headers)
- Query parameter validation
- Configurable error responses (400 for request, 500 for response violations)

#### 2.4 Query Plugin
Universal REST patterns for array responses:
- Auto-handles `?page=2&limit=10&sort=name&filter[role]=admin`
- Configurable defaults and limits
- Works with array responses from generators

#### 2.5 Performance & Bundle Analysis
Baseline metrics and monitoring:
- Bundle size tracking
- Benchmark `handle()` throughput
- Tree-shaking verification
- Documented baseline metrics

### Product Phase 3 — Complete
The original OpenAPI and standalone-server product milestone is complete.

#### 3.1 OpenAPI Plugin
Implemented OpenAPI/Swagger auto-mock generation:
- `install()` hook for route registration at `.pipe()` time
- Parser with circular reference handling (using `@apidevtools/swagger-parser`)
- Normalizer for schema transformation and discriminator mapping
- CRUD detector for RESTful resource grouping
- Response generators from OpenAPI schema definitions
- Seed data support for realistic mock responses
- Example response extraction from spec `examples`
- One-liner: `schmock.pipe(openapi({ spec: './swagger.json', seedData }))`
- Stress tested with Petstore, Train Travel, Scalar Galaxy, and Stripe (5.8MB, 415 endpoints)

#### 3.2 Standalone Server & CLI
- `.listen(port?, hostname?)` for running as HTTP server
- `@schmock/cli` for starting a mock server from the command line
- Seed file support for realistic initial data

### Production Hardening — Phases 1 and 2 Complete Locally

The post-v2.3.0 worktree has completed and locally verified:

- Deterministic clean and repeated package builds with stale-artifact removal
- Standalone public declarations for all package entries, including a packed TypeScript 5.6 Core consumer
- Shared React context identity across `@schmock/react` and `@schmock/react/testing`
- Persistent default state, mock-owned global configuration, and atomic, scoped plugin installation
- Synchronous server-start reservation, pending-start cancellation, and same-port restart barriers
- Request-admission snapshots across routes, state, plugins, history, and adapters
- Deferred reverse-order plugin cleanup after admitted requests settle
- Isolated lifecycle observers and detached request-history snapshots
- Fetch `RequestInit`, browser-relative URL, passthrough, and cancellation fidelity
- One final response contract across Core, Fetch, Node HTTP, Express, Angular, and CLI
- Structured 400/413 Node ingress handling with exact 10 MiB limits

Final local evidence is 1,928 unit, 1,307 BDD, 137 integration, and 14 E2E
tests, plus lint, build, TypeScript 5.6, reproducibility, packed-consumer,
`publint`, and `attw` gates. Fresh remote CI is still pending. Audit findings
M10 onward remain open in whole or in part; see
[`CODEBASE-ANALYSIS.md`](../CODEBASE-ANALYSIS.md) for the next phases.

### Product Phase 4 — Future
- **Network error simulation**: Timeouts, connection refused (beyond HTTP error codes)
- **Sequence responses**: Declarative successive response patterns
- **Caching plugin**: Response caching with TTL
- **Persistence plugin**: Data persistence across sessions
- **GraphQL support**: Schema-driven GraphQL mocks
- **WebSocket support**: Real-time mock endpoints
- **Plugin marketplace**: Community plugin ecosystem
- **VS Code extension**: Enhanced development experience

## Technical Highlights

### Modern Architecture
- **ESM-first**: Full ES module support
- **TypeScript 6.0**: Repository compiler, with packed Core declarations also checked under TypeScript 5.6
- **Bun workspaces**: Fast package management
- **Biome**: Modern linting and formatting
- **Vitest**: Fast test execution with BDD support

### Developer Experience
- **Zero config**: Works out of the box
- **Type inference**: Full IntelliSense support
- **Debug mode**: Comprehensive request/response logging
- **Auto content-type**: Detects JSON, text, binary automatically
- **Delay simulation**: Fixed or random response delays

## Gap Analysis vs Competitors

### Covered
- Conditional responses (generator functions with full context)
- Delay simulation (`schmock({ delay })`)
- Complete user flows (shopping cart, sessions, multi-user isolation)
- Stateful mocks with shared mutable state
- Plugin pipeline for extensibility
- Framework adapters (Express, Angular, React, Vue)
- **Request spy/history** — MSW, nock, WireMock, Mirage JS all have this
- **Reset/lifecycle** — MSW (`resetHandlers`), nock (`cleanAll`), Mirage JS (`shutdown`)
- **Validation** — WireMock verification, contract testing
- **Query helpers** — json-server pagination/filtering
- **OpenAPI auto-mock** — Prism, Stoplight, Swagger UI

### Future Product Gaps
- Network error simulation (timeouts, connection refused)
- Sequence/multi-response patterns
- GraphQL support
- WebSocket support

---

**Status**: Active development; release-artifact and core lifecycle/transport hardening complete locally, fresh remote CI pending
**License**: MIT
**Maintained by**: Khalic Lab
