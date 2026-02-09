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

## Current Architecture (v1.7.x)

### Packages

| Package | Version | Description |
|---------|---------|-------------|
| `@schmock/core` | 1.7.0 | Core callable API with plugin pipeline |
| `@schmock/faker` | 1.7.0 | Faker-powered automatic data generation plugin |
| `@schmock/express` | 1.7.0 | Express middleware adapter |
| `@schmock/angular` | 1.7.0 | Angular HTTP interceptor adapter |
| `@schmock/validation` | 1.7.0 | Request/response JSON Schema validation plugin |
| `@schmock/query` | 1.7.0 | Pagination, filtering, sorting plugin |
| `@schmock/openapi` | 1.7.0 | OpenAPI/Swagger auto-mock generation plugin |
| `@schmock/cli` | 1.7.0 | Standalone CLI server from OpenAPI specs |

### Package Structure
```
schmock/
├── packages/
│   ├── core/           # Core callable API with plugin pipeline
│   ├── schema/         # JSON Schema generation plugin
│   ├── express/        # Express middleware adapter
│   ├── angular/        # Angular HTTP interceptor adapter
│   ├── validation/     # Request/response validation plugin
│   ├── query/          # Pagination, filtering, sorting plugin
│   └── openapi/        # OpenAPI/Swagger auto-mock generation plugin
├── features/           # BDD test specifications
├── types/              # Shared TypeScript ambient types
├── docs/               # API documentation
└── benchmarks/         # Performance benchmarks
```

## Development Status

### Phase 1 — Complete (v1.0.x)
- **Core callable API**: Direct mock instance creation and usage
- **Plugin pipeline**: `.pipe()` chaining architecture
- **Route handling**: All HTTP methods with path parameters
- **State management**: Shared mutable state between requests
- **Express adapter**: Full middleware integration
- **Angular adapter**: HTTP interceptor implementation
- **Schema plugin**: JSON Schema-based data generation with faker.js
- **TypeScript support**: Full type safety with ambient types
- **BDD testing**: Comprehensive test coverage with vitest-cucumber
- **CI/CD**: GitHub Actions workflows
- **Monorepo setup**: Bun workspaces with proper dependencies
- **Developer experience**: Debug mode, auto content-type detection, delay simulation

### Phase 2 — Complete (v1.2.x)
All critical gaps addressed for production readiness:

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

### Phase 3 — Complete (v1.1.x)
**North Star achieved**: throw a `swagger.json` at Schmock and let it manage the rest.

#### 3.1 OpenAPI Plugin
Full OpenAPI/Swagger auto-mock generation:
- `install()` hook for route registration at `.pipe()` time
- Parser with circular reference handling (using `@apidevtools/swagger-parser`)
- Normalizer for schema transformation and discriminator mapping
- CRUD detector for RESTful resource grouping
- Response generators from OpenAPI schema definitions
- Seed data support for realistic mock responses
- Example response extraction from spec `examples`
- One-liner: `schmock.pipe(openapi({ spec: './swagger.json', seedData }))`
- Stress tested with Petstore, Train Travel, Scalar Galaxy, and Stripe (5.8MB, 415 endpoints)

#### 3.2 Supporting Features
Deferred to Phase 4:
- **Network error simulation**: Timeouts, connection refused (beyond HTTP error codes)
- **Sequence responses**: Declarative successive response patterns
- **Caching plugin**: Response caching with TTL
- **Persistence plugin**: Data persistence across sessions

### Phase 4 — Future
- **Network error simulation**: Timeouts, connection refused (beyond HTTP error codes)
- **Sequence responses**: Declarative successive response patterns
- **Caching plugin**: Response caching with TTL
- **Persistence plugin**: Data persistence across sessions
- **GraphQL support**: Schema-driven GraphQL mocks
- **WebSocket support**: Real-time mock endpoints
- **Plugin marketplace**: Community plugin ecosystem
- **CLI tools**: Project scaffolding and utilities
- **VS Code extension**: Enhanced development experience

## Technical Highlights

### Modern Architecture
- **ESM-first**: Full ES module support
- **TypeScript 5.9**: Latest TypeScript features
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
- Framework adapters (Express, Angular)
- **Request spy/history** — MSW, nock, WireMock, Mirage JS all have this
- **Reset/lifecycle** — MSW (`resetHandlers`), nock (`cleanAll`), Mirage JS (`shutdown`)
- **Validation** — WireMock verification, contract testing
- **Query helpers** — json-server pagination/filtering
- **OpenAPI auto-mock** — Prism, Stoplight, Swagger UI

### Future Gaps (Phase 4)
- Network error simulation (timeouts, connection refused)
- Sequence/multi-response patterns
- GraphQL support
- WebSocket support

---

**Status**: Active development
**License**: MIT
**Maintained by**: Khalic Lab
