# Schmock 🎭
> Schema-driven mock API generator with business constraints

## Project Vision
A plugin-based, framework-agnostic tool that generates intelligent mock APIs from JSON Schema, enhanced with business rules and optional stateful behavior.

## Core Philosophy
- **Start simple, grow smart**: Basic mocking in <30 seconds, advanced features when needed
- **Plugin everything**: Core does one thing well, plugins add superpowers
- **Framework agnostic**: Works everywhere JavaScript runs
- **Type safe**: First-class TypeScript support

## Architecture Overview

### Core Package (`@schmock/core`)
Minimal engine (~10KB) that provides:
- Plugin API
- Route matching
- Basic request/response handling
- Event system

```typescript
import { Schmock } from '@schmock/core';

const schmock = new Schmock({
  routes: {
    '/api/users': './schemas/user.json',
    '/api/posts': './schemas/post.json'
  }
});

// That's it! Basic mocking ready
```

### Official Plugins

#### 1. **Schema Plugin** (`@schmock/plugin-schema`)
- JSON Schema validation
- $ref resolution
- Default value generation
- Basic faker.js integration

#### 2. **Constraints Plugin** (`@schmock/plugin-constraints`)
- Business rule engine
- Field-level constraints
- Cross-field validation
- Custom generators

```javascript
schmock.use(constraints({
  '/api/orders': {
    fields: {
      price: ({ record }) => {
        const category = record.category;
        return faker.number.float({
          min: category === 'premium' ? 100 : 10,
          max: category === 'premium' ? 1000 : 100
        });
      },
      email: ({ record }) => {
        return `${record.firstName.toLowerCase()}@company.com`;
      }
    },
    validate: ({ record }) => {
      if (record.shippedDate && record.shippedDate < record.orderDate) {
        throw new Error('Cannot ship before order date');
      }
      return record;
    }
  }
}));
```

#### 3. **State Plugin** (`@schmock/plugin-state`)
- SQLite persistence (sql.js in browser, better-sqlite3 in Node)
- CRUD operations
- Relationships
- Session management

```javascript
schmock.use(state({
  adapter: 'sqlite', // or 'memory', 'indexeddb'
  database: ':memory:',
  relationships: {
    '/api/orders': {
      belongsTo: { user: '/api/users' },
      hasMany: { items: '/api/order-items' }
    }
  }
}));
```

#### 4. **Query Plugin** (`@schmock/plugin-query`)
- Pagination
- Filtering
- Sorting
- Aggregations

```javascript
// Automatically handles: GET /api/users?page=2&limit=10&sort=-createdAt&filter[role]=admin
schmock.use(query({
  '/api/users': {
    filterable: ['role', 'status', 'createdAt'],
    sortable: ['name', 'createdAt'],
    paginate: { defaultLimit: 20, maxLimit: 100 }
  }
}));
```

### Framework Adapters

#### Angular (`@schmock/angular`)
```typescript
import { provideSchmock } from '@schmock/angular';

export const appConfig: ApplicationConfig = {
  providers: [
    provideSchmock(schmock),
    // or with lazy loading
    provideSchmock(() => import('./schmock.config'))
  ]
};
```

#### React/Vue/Svelte (`@schmock/msw`)
```javascript
import { toMSW } from '@schmock/msw';

const worker = setupWorker(...toMSW(schmock));
worker.start();
```

#### Express/Node (`@schmock/express`)
```javascript
import { middleware } from '@schmock/express';

app.use('/api', middleware(schmock));
```

## Plugin API

```typescript
interface SchmockPlugin {
  name: string;
  version: string;
  
  // Lifecycle hooks
  setup?(schmock: Schmock): void;
  beforeRequest?(context: RequestContext): void | Promise<void>;
  generate?(context: GenerateContext): any | Promise<any>;
  afterGenerate?(context: GenerateContext, data: any): any;
  beforeResponse?(context: ResponseContext): void;
  
  // Extension points
  extendRoute?(route: RouteConfig): RouteConfig;
  extendSchema?(schema: JsonSchema): JsonSchema;
}

// Example custom plugin
const myPlugin: SchmockPlugin = {
  name: 'schmock-plugin-audit',
  version: '1.0.0',
  
  beforeRequest(context) {
    console.log(`[AUDIT] ${context.method} ${context.path}`);
  },
  
  afterGenerate(context, data) {
    return {
      ...data,
      _debug: {
        generatedAt: new Date().toISOString(),
        seed: context.seed
      }
    };
  }
};
```

## Developer Experience

### CLI
```bash
# Initialize with interactive setup
npx schmock init

# Generate TypeScript types from schemas
npx schmock generate types

# Start dev server with hot reload
npx schmock serve --watch

# Export current session
npx schmock export session.db

# Run with specific config
npx schmock serve --config schmock.prod.js
```

### DevTools Extension
- View active routes and schemas
- Inspect generated data
- Edit constraints in real-time
- Export/import sessions
- Performance metrics

### VS Code Extension
- Schema IntelliSense
- Constraint snippets
- Validate schemas on save
- Jump between schema ↔ constraint files

## Project Timeline

### Phase 1: Core + Basic Schema (Weeks 1-2)
- [ ] Core plugin system
- [ ] Basic route matching
- [ ] Schema plugin with json-schema-faker
- [ ] Angular adapter

### Phase 2: Constraints + State (Weeks 3-4)
- [ ] Constraints plugin
- [ ] State plugin with SQLite
- [ ] Session management
- [ ] Basic DevTools

### Phase 3: Polish + Ecosystem (Weeks 5-6)
- [ ] Query plugin
- [ ] MSW adapter
- [ ] CLI with templates
- [ ] Documentation site

### Phase 4: Community (Week 7+)
- [ ] Plugin marketplace
- [ ] VS Code extension
- [ ] Video tutorials
- [ ] Example projects

## Success Metrics
- **Time to first mock**: <30 seconds
- **Bundle size**: Core <10KB, typical setup <150KB
- **Performance**: Generate 1000 records <100ms
- **Adoption**: 1000 stars in 3 months

## Marketing Strategy
1. **Launch**: "Introducing Schmock: Mocking That Just Works"
2. **Comparisons**: Clear positioning vs MSW, JSON Server, Mirage
3. **Tutorials**: Framework-specific getting started guides
4. **Community**: Discord, plugin contests, conference talks

## Technical Decisions
- **TypeScript first**: Written in TS, amazing DX
- **ESM only**: Modern tooling, better tree-shaking
- **Zero dependencies** in core
- **Semantic versioning** from day one

## Open Questions
1. Should we support GraphQL from the start or via plugin?
2. Browser DevTools or standalone Electron app?
3. Free vs paid plugins model?
4. OpenAPI import in core or plugin?