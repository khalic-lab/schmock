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
- `bun test` - Run all tests (unit + BDD across all packages)
- `bun test:all` - **Full comprehensive test suite with typecheck** (recommended before commits)
- `bun test:unit` - Run unit tests only (all packages)
- `bun test:bdd` - Run BDD tests only
- `act push -W .github/workflows/develop.yml` - Test CI locally

## Development Guidelines

### Initial Setup
After cloning the repository, run:
```bash
bun install
bun run setup  # Configure Git hooks (linting + tests on commit)
```

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
**With Git hooks (automatic):**
- Pre-commit hook runs `bun run lint` and `bun run test:all` automatically
- Commit-msg hook enforces conventional commit format
- Use `git commit --no-verify` to bypass (not recommended)

**Manual checks (if hooks disabled):**
1. Run `bun lint` - Must pass
2. Run `bun build` - Must compile  
3. Run `bun test:all` - **Recommended: Full test suite with typecheck**
   - Alternative: `bun test` (faster, but skips typecheck)
   - BDD tests may fail during feature development (expected for TDD)

**IMPORTANT: Never add Claude signatures to commit messages**

## Current Development Status

Schmock is **feature-complete** with a production-ready callable API:

### ✅ Completed Core Features
- **Callable API**: Direct mock instance creation with zero boilerplate
- **Plugin Pipeline**: Extensible `.pipe()` architecture for advanced features  
- **All HTTP Methods**: GET, POST, PUT, DELETE, PATCH with parameters
- **Stateful Mocks**: Shared state management between requests
- **Framework Adapters**: Express middleware and Angular HTTP interceptor
- **Schema Integration**: JSON Schema-based data generation
- **Type Safety**: Full TypeScript support with ambient types

### ✅ Quality Assurance Infrastructure  
- **Comprehensive Testing**: Unit tests and BDD tests across all packages
- **Automated Git Hooks**: Pre-commit linting and testing (use `bun run setup`)
- **CI/CD Pipeline**: GitHub Actions with matrix strategy for parallel execution
- **Type Safety**: Strict TypeScript compilation across all packages
- **Documentation**: Complete API docs, guides, and development workflows

### 🔄 Current Focus Areas
- **Performance Optimization**: Bundle size analysis and runtime efficiency
- **Plugin Ecosystem**: Additional official plugins (validation, caching, persistence)
- **Developer Experience**: Enhanced error messages and debugging tools
- **Production Readiness**: Edge case handling and stability improvements

### 📋 Future Direction
- **Performance Focus**: Bundle analysis and runtime optimization
- **Plugin Ecosystem**: Additional official plugins for common use cases
- **Stability**: API stability guarantee and production-ready documentation

The core implementation is complete with comprehensive test coverage.