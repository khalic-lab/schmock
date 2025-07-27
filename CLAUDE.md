# Schmock Project Instructions

## GitHub Flow

This project uses GitHub Flow with the following workflow:

### Branches
- **main**: Production-ready code, protected branch
- **develop**: Active development branch, all features merge here first
- **feature/**: Feature branches created from develop

### Workflow
1. **Start new work**: Create feature branch from develop
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/your-feature-name
   ```

2. **During development**:
   - Commit frequently with clear messages
   - Run tests locally: `bun test`
   - Run BDD tests: `bun test:bdd`
   - Ensure linting passes: `bun lint`

3. **Create PR**:
   - Push feature branch to GitHub
   - Create PR from feature → develop
   - CI will run automatically and comment BDD test status
   - BDD tests may fail during development (expected for TDD)

4. **After PR approval**:
   - Merge to develop
   - Delete feature branch
   - When develop is stable, create PR develop → main

### CI/CD Status
- **Develop branch**: Runs all tests, BDD failures allowed
- **PRs to main**: All tests must pass
- **Main branch**: Protected, requires PR reviews

## Testing Strategy

### BDD/TDD Workflow
1. BDD tests in `/features/*.feature` define behavior
2. Step definitions in `packages/*/src/steps/*.steps.ts`
3. Write failing BDD test first
4. Implement code to make test pass
5. Refactor while keeping tests green

### Test Commands
- `bun test` - Run all tests
- `bun test:unit` - Run unit tests only
- `bun test:bdd` - Run BDD tests only
- `act push -W .github/workflows/develop.yml` - Test CI locally

## Development Guidelines

### Code Style
- TypeScript strict mode enabled
- Use ambient types in `/types/schmock.d.ts`
- Follow existing patterns in codebase
- No unnecessary comments

### Monorepo Structure
- Packages in `/packages/*`
- Shared types in `/types/*`
- Features in `/features/*`
- Each package has own build/test scripts

### Before Committing
1. Run `bun lint` - Must pass
2. Run `bun build` - Must compile
3. Run `bun test:unit` - Must pass
4. Run `bun test:bdd` - May fail during feature development

## Current Development Focus

Working on Schmock core implementation:
1. Basic route matching
2. Request/response handling
3. Plugin system architecture
4. Event system for plugins

See failing BDD tests for implementation requirements.