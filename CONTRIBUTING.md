# Contributing

## Setup

```sh
git clone <repo>
cd schmock
bun install
bun run setup   # configure git hooks
bun run build
```

## Project Structure

```
schmock/
├── packages/
│   ├── core/           # Core mock builder, routing, plugin pipeline
│   ├── faker/          # Faker-powered data generation
│   ├── validation/     # Request/response validation (AJV)
│   ├── query/          # Pagination, sorting, filtering
│   ├── openapi/        # OpenAPI/Swagger auto-mock plugin
│   ├── express/        # Express middleware adapter
│   ├── angular/        # Angular HTTP interceptor adapter
│   └── cli/            # Standalone CLI server
├── features/           # BDD feature files (.feature)
├── tests/integration/  # Integration test suite
├── docs/               # API documentation
└── benchmarks/         # Performance benchmarks
```

## Testing

```sh
bun test:all           # typecheck + unit + BDD + integration
bun test:unit          # unit tests only
bun test:bdd           # BDD tests only
bun test:integration   # integration tests only
bun run typecheck      # type checking
bun run lint           # linting (Biome)
bun run lint:fix       # auto-fix lint issues
```

## Workflow

1. Branch from `develop`:
   ```sh
   git checkout develop && git pull
   git checkout -b feature/your-feature
   ```

2. Write a `.feature` file first (BDD-first), then step definitions, then implement.

3. Commit with conventional messages: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`

4. Git hooks automatically run lint + tests on commit.

5. PR flow: `feature/*` -> `develop` -> `main`

## Quality Gate

Pre-commit hooks enforce:
- Biome lint and format
- TypeScript type checking
- Unit + BDD tests
- Benchmarks

See [CLAUDE.md](./CLAUDE.md) for detailed project architecture and conventions.
