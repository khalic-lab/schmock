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

## Current Architecture (v1.0.x)

### Packages

| Package | Version | Description |
|---------|---------|-------------|
| `@schmock/core` | 1.0.4 | Core callable API with plugin pipeline |
| `@schmock/schema` | 1.0.2 | JSON Schema-based data generation plugin |
| `@schmock/express` | 1.0.2 | Express middleware adapter |
| `@schmock/angular` | 1.3.2 | Angular HTTP interceptor adapter |

### Package Structure
```
schmock/
├── packages/
│   ├── core/           # Core callable API with plugin pipeline
│   ├── schema/         # JSON Schema generation plugin
│   ├── express/        # Express middleware adapter
│   ├── angular/        # Angular HTTP interceptor adapter
│   ├── validation/     # Request/response validation plugin (Phase 2)
│   └── query/          # Pagination, filtering, sorting plugin (Phase 2)
├── features/           # BDD test specifications
├── types/              # Shared TypeScript ambient types
├── docs/               # API documentation
├── benchmarks/         # Performance benchmarks (Phase 2)
└── e2e/                # End-to-end integration tests
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

### Phase 2 — In Progress
Priority order based on adoption impact:

#### 2.1 Request Spy / History API (Critical)
Every serious mocking library supports request assertions. This is the biggest gap.
- `mock.history()` — all recorded requests
- `mock.history('GET', '/users')` — filtered by method + path
- `mock.called()` / `mock.called('POST', '/users')` — boolean assertions
- `mock.callCount()` / `mock.callCount('GET', '/users')` — count assertions
- `mock.lastRequest()` / `mock.lastRequest('POST', '/users')` — most recent request
- `RequestRecord` type with method, path, params, query, headers, body, timestamp, response

#### 2.2 Mock Reset / Lifecycle (Critical)
Required for clean test isolation between test cases.
- `mock.reset()` — clear all routes, state, and history
- `mock.resetHistory()` — clear only request history
- `mock.resetState()` — clear only state, keep routes

#### 2.3 Validation Plugin (High)
Ensure mocks enforce API contracts via JSON Schema validation.
- Request body validation
- Response body validation
- Header validation (required headers)
- Query parameter validation
- Configurable error responses (400 for request, 500 for response violations)

#### 2.4 Query Plugin (High)
Pagination, filtering, sorting are universal REST patterns.
- Auto-handles `?page=2&limit=10&sort=name&filter[role]=admin`
- Configurable defaults and limits
- Works with array responses from generators

#### 2.5 Performance & Bundle Analysis (Medium)
- Bundle size tracking
- Benchmark `handle()` throughput
- Tree-shaking verification
- Baseline metrics documentation

### Phase 3 — Planned (OpenAPI-first)
The end goal: **throw a `swagger.json` at Schmock and let it manage the rest.**

#### 3.1 OpenAPI Plugin (Critical — North Star Feature)
Parse OpenAPI/Swagger specs and auto-generate a full mock server:
- Route registration from paths
- Response generation from schema definitions (using `@schmock/schema`)
- Request validation from parameter/body schemas (using `@schmock/validation`)
- Pagination from path conventions (using `@schmock/query`)
- Example responses from `examples` in spec
- One-liner: `schmock.fromOpenAPI('./swagger.json')`

#### 3.2 Supporting Features
- **Network error simulation**: Timeouts, connection refused (beyond HTTP error codes)
- **Sequence responses**: Declarative successive response patterns
- **Caching plugin**: Response caching with TTL
- **Persistence plugin**: Data persistence across sessions

### Phase 4 — Future
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

### Gaps Being Addressed (Phase 2)
- **Request spy/history** — MSW, nock, WireMock, Mirage JS all have this
- **Reset/lifecycle** — MSW (`resetHandlers`), nock (`cleanAll`), Mirage JS (`shutdown`)
- **Validation** — WireMock verification, contract testing
- **Query helpers** — json-server pagination/filtering

### Lower Priority Gaps
- Network error simulation (timeouts, connection refused)
- OpenAPI/Swagger integration
- Sequence/multi-response patterns

---

**Status**: Active development
**License**: MIT
**Maintained by**: Khalic Lab
