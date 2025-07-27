# Schmock vs Alternatives

## Feature Comparison

| Feature | Schmock | MSW | JSON Server | Mirage JS | Mockoon |
|---------|---------|-----|-------------|-----------|----------|
| **Schema-driven** | ✅ Native | ❌ Manual | ⚠️ Basic | ❌ Manual | ⚠️ Basic |
| **Business Constraints** | ✅ Plugin | ❌ | ❌ | ⚠️ Limited | ❌ |
| **Stateful CRUD** | ✅ Plugin | ❌ | ✅ | ✅ | ⚠️ Basic |
| **Relationships** | ✅ Plugin | ❌ | ❌ | ✅ | ❌ |
| **Framework Agnostic** | ✅ | ✅ | ✅ | ❌ Ember/React | ✅ |
| **TypeScript Types** | ✅ Auto-generated | ❌ Manual | ❌ | ❌ | ❌ |
| **Plugin System** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Bundle Size** | ~10KB core | ~50KB | ~30KB | ~200KB | N/A (Desktop) |
| **Setup Time** | <30 seconds | 5-10 minutes | 2-5 minutes | 10-20 minutes | 2-5 minutes |

## Use Case Comparison

### "I need quick mocks for my Angular app"
```typescript
// Schmock ✅
const schmock = new Schmock({
  routes: { '/api/users': './schemas/user.json' }
});
export default schmock.angularInterceptor();

// MSW ❌ - More setup needed
const handlers = [
  rest.get('/api/users', (req, res, ctx) => {
    return res(ctx.json(/* manually write data */))
  })
];
```

### "I need mocks that follow business rules"
```javascript
// Schmock ✅
schmock.use(constraints({
  '/api/orders': {
    fields: {
      total: ({ items }) => items.reduce((sum, i) => sum + i.price, 0),
      shippedDate: ({ orderDate }) => addDays(orderDate, 2)
    }
  }
}));

// Others ❌ - Must implement manually
```

### "I need stateful mocks for e2e tests"
```javascript
// Schmock ✅
schmock.use(state({ adapter: 'sqlite' }));
// Automatic CRUD with relationships

// Mirage JS ⚠️ - Good but requires more code
createServer({
  models: {
    user: Model,
    order: Model.extend({
      user: belongsTo()
    })
  }
  // ... more setup
});
```

## Migration Paths

### From JSON Server
```bash
# 1. Install Schmock
npm install @schmock/core @schmock/plugin-state

# 2. Your db.json becomes schemas
mv db.json schemas/

# 3. Same API, more features!
```

### From MSW
```javascript
// Keep your MSW handlers, add Schmock for data
import { toMSW } from '@schmock/msw';

const handlers = [
  ...existingHandlers,
  ...toMSW(schmock) // Schmock handles data generation
];
```

### From Mirage
```javascript
// Similar concepts, cleaner syntax
// Mirage
createServer({
  models: { user: Model },
  factories: {
    user: Factory.extend({
      name() { return faker.name.fullName() }
    })
  }
});

// Schmock
new Schmock({ routes: { '/api/users': './schemas/user.json' }})
  .use(constraints({
    '/api/users': {
      fields: { name: () => faker.name.fullName() }
    }
  }));
```

## Why Schmock?

1. **Progressive Enhancement**: Start simple, add complexity only when needed
2. **Schema-First**: Your API contract drives everything
3. **Plugin Ecosystem**: Community-driven features
4. **Type Safety**: Auto-generated TypeScript types
5. **Framework Agnostic**: One config, all frameworks
6. **Production-Ready**: Used by [future big companies here]

## When NOT to use Schmock

- ❌ You need a full backend (use a real API)
- ❌ You're mocking external APIs you don't control (use MSW with manual responses)
- ❌ You need complex authentication flows (use a real auth service)
- ❌ You're building a public API (use a real server)

## When Schmock SHINES

- ✅ Rapid prototyping
- ✅ Frontend development without backend
- ✅ E2E testing with complex data requirements
- ✅ Demo environments with realistic data
- ✅ Teaching/workshops with consistent data
- ✅ Offline development