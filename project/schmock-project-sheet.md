# Schmock 🎭

> Schema-driven mock API generator with direct callable API and plugin pipeline

## Project Vision
A lightweight, framework-agnostic tool that provides immediate callable mock APIs with zero boilerplate, enhanced through an extensible plugin pipeline architecture.

## Core Philosophy
- **Direct callable API**: No build() needed - define and use immediately
- **Zero boilerplate**: Get running in under 30 seconds
- **Plugin pipeline**: Extensible `.pipe()` architecture for advanced features
- **Framework agnostic**: Works everywhere JavaScript runs
- **Type safe**: First-class TypeScript support with ambient types

## Current Architecture (v0.2.0)

### Core Package (`@schmock/core`)
Lightweight engine providing direct callable API:

```typescript
import { schmock } from '@schmock/core'

// Create and use immediately - no build() needed!
const mock = schmock({ debug: true, namespace: '/api' })

// Define routes directly
mock('GET /users', () => [
  { id: 1, name: 'John Doe', email: 'john@example.com' }
], { contentType: 'application/json' })

// Use immediately
const response = await mock.handle('GET', '/api/users')
console.log(response.body) // [{ id: 1, name: 'John Doe', ... }]
```

### Key Features Implemented

#### ✅ Direct Callable API
- No builder pattern - callable instances work immediately
- Generator functions vs static data auto-detection
- Custom status codes and headers support
- Path parameters, query strings, headers access

#### ✅ Plugin Pipeline
```typescript
mock('GET /users', userSchema, { contentType: 'application/json' })
  .pipe(schemaPlugin())
  .pipe(validationPlugin())
  .pipe(cachingPlugin())
```

#### ✅ Stateful Mocks
```typescript
const mock = schmock({ 
  state: { users: [] },
  debug: true 
})

mock('POST /users', ({ body, state }) => {
  const newUser = { id: Date.now(), ...body }
  state.users.push(newUser)
  return [201, newUser]
})
```

#### ✅ Framework Adapters

**Express** (`@schmock/express`):
```typescript
import express from 'express'
import { toExpress } from '@schmock/express'

const app = express()
app.use('/api', toExpress(mock))
```

**Angular** (`@schmock/angular`):
```typescript
import { HttpInterceptor } from '@angular/common/http'
import { SchmockInterceptor } from '@schmock/angular'

// Injectable HTTP interceptor for Angular apps
```

### Current Package Structure
```
schmock/
├── packages/
│   ├── core/           # ✅ Core callable API with plugin pipeline
│   ├── schema/         # ✅ JSON Schema generation plugin
│   ├── express/        # ✅ Express middleware adapter  
│   └── angular/        # ✅ Angular HTTP interceptor adapter
├── features/           # ✅ BDD test specifications
├── types/              # ✅ Shared TypeScript ambient types
├── docs/               # ✅ API documentation
└── e2e/               # ✅ End-to-end integration tests
```

## Development Status

### ✅ Completed (Phase 1)
- **Core callable API**: Direct mock instance creation and usage
- **Plugin pipeline**: `.pipe()` chaining architecture
- **Route handling**: All HTTP methods with parameters
- **State management**: Shared mutable state between requests
- **Express adapter**: Full middleware integration
- **Angular adapter**: HTTP interceptor implementation
- **Schema plugin**: JSON Schema-based data generation
- **TypeScript support**: Full type safety with ambient types
- **BDD testing**: Comprehensive test coverage
- **CI/CD**: Robust GitHub Actions workflows
- **Monorepo setup**: Bun workspaces with proper dependencies

### 🔄 Current Focus (Phase 2)
- **Performance optimization**: Bundle size and runtime efficiency
- **Plugin ecosystem**: Additional official plugins
- **Documentation**: Comprehensive guides and examples
- **Developer experience**: Better error messages and debugging

### 📋 Planned (Phase 3)
- **Query plugin**: Pagination, filtering, sorting
- **Validation plugin**: Request/response validation
- **Caching plugin**: Response caching with TTL
- **Persistence plugin**: Data persistence across sessions
- **CLI tools**: Project scaffolding and utilities
- **DevTools**: Browser extension for debugging

### 🚀 Future (Phase 4)
- **GraphQL support**: Schema-driven GraphQL mocks
- **WebSocket support**: Real-time mock endpoints
- **Plugin marketplace**: Community plugin ecosystem
- **VS Code extension**: Enhanced development experience

## Technical Highlights

### Modern Architecture
- **ESM-first**: Full ES module support
- **TypeScript 5.9**: Latest TypeScript features
- **Bun workspaces**: Fast package management
- **Biome**: Modern linting and formatting
- **Vitest**: Fast test execution with BDD support

### CI/CD Excellence
- **Matrix strategy**: Parallel job execution
- **Dependency caching**: Fast, reliable builds
- **Release automation**: Conventional commits with release-please
- **Monorepo support**: Per-package Dependabot updates

### Developer Experience
- **Zero config**: Works out of the box
- **Hot reloading**: Instant feedback during development
- **Type inference**: Full IntelliSense support
- **Debug mode**: Comprehensive request/response logging

## Project Metrics

- **Bundle size**: Core package ~15KB minified
- **Test coverage**: >90% across all packages
- **TypeScript strict**: 100% type safety
- **Dependencies**: Minimal, well-maintained
- **Performance**: <1ms response time for simple mocks

## Next Milestones

### v0.3.0 (Next Release)
- [ ] Performance benchmarking and optimization
- [ ] Additional plugin examples and documentation
- [ ] Error handling improvements
- [ ] Bundle analysis and size reduction

### v1.0.0 (Stable Release)
- [ ] API stability guarantee
- [ ] Comprehensive documentation site
- [ ] Migration guides from other mock libraries
- [ ] Production usage examples and case studies

---

**Status**: Active development, production-ready core features
**License**: MIT
**Maintained by**: Khalic Lab