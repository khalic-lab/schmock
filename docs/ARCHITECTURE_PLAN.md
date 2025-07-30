# Schmock Architecture Improvement Plan

## Overview

This document outlines the architectural improvements for the Schmock project, divided into phases to ensure systematic enhancement of the codebase.

## Phase 1: Core Architecture Improvements ✅ COMPLETED

### Objectives
- Fix fundamental TypeScript configuration issues
- Standardize build and development processes
- Improve type safety and error handling
- Establish cleanup mechanisms to prevent build artifacts in source directories

### Completed Tasks

#### 1.1 TypeScript Configuration
- ✅ Removed non-existent `@schmock/core` reference from tsconfig.json
- ✅ Updated path mappings to reflect actual package structure
- ✅ Fixed project references for proper composite builds

#### 1.2 Build System Standardization
- ✅ Unified build scripts across all packages (schema, builder, express)
- ✅ Added consistent scripts: `build:lib`, `build:types`, `lint`, `lint:fix`
- ✅ Standardized package.json exports configuration

#### 1.3 Dependency Alignment
- ✅ Updated all packages to use Vitest v3.2.4
- ✅ Fixed Express package TypeScript configuration
- ✅ Added proper project references

#### 1.4 Type Safety Improvements
- ✅ Created comprehensive error class hierarchy:
  - `SchmockError` - Base error class with code and context
  - `RouteNotFoundError` - For missing routes
  - `RouteParseError` - For invalid route key formats
  - `ResponseGenerationError` - For response generation failures
  - `PluginError` - For plugin execution failures
  - `RouteDefinitionError` - For invalid route definitions
- ✅ Replaced generic Error throws with typed errors
- ✅ Added error context for better debugging

#### 1.5 Plugin Architecture Restoration
- ✅ Re-implemented plugin system in builder
- ✅ Added `generateViaPlugins` method for routes without response functions
- ✅ Proper error wrapping for plugin failures
- ✅ Event emission for plugin lifecycle

#### 1.6 Cleanup Mechanisms
- ✅ Added `.gitignore` entries to prevent generated files in source directories
- ✅ Created `clean:src` and `clean:dist` scripts
- ✅ Added pre-test cleanup hooks to ensure fresh builds
- ✅ Created reusable cleanup utility script (`scripts/clean-generated.js`)
- ✅ Prevented future issues with stale transpiled files

### Test Results
- ✅ Unit tests: All passing
- ✅ TypeScript compilation: Successful
- ⚠️ BDD tests: Failing (expected - requires Phase 2 completion)

## Phase 2: Plugin System Enhancement (IN PROGRESS)

### Objectives
- Complete schema plugin integration with proper error handling
- Add comprehensive plugin hooks throughout request lifecycle
- Improve framework adapter type preservation
- Enable plugins to extend builder functionality

### Planned Tasks

#### 2.1 Schema Plugin Integration
- [ ] Move schema validation into plugin lifecycle
- [ ] Add strict schema validation before generation
- [ ] Integrate schema errors with typed error system
- [ ] Support for schema references and complex types
- [ ] Add schema caching for performance

#### 2.2 Plugin Hook System
- [ ] Add lifecycle hooks:
  - `beforeRequest` - Pre-processing and validation
  - `beforeGenerate` - Data generation preparation
  - `afterGenerate` - Post-generation transformation
  - `beforeResponse` - Final response modifications
  - `onError` - Error handling and recovery
- [ ] Enable plugin ordering and dependencies
- [ ] Add plugin configuration validation

#### 2.3 Builder-Plugin Integration
- [ ] Allow plugins to extend route definitions
- [ ] Enable plugins to add builder methods
- [ ] Support for plugin-specific route options
- [ ] Add plugin composition patterns

### Expected Outcomes
- Schema generation with proper error handling
- Extensible plugin system for future features
- Better separation of concerns
- All BDD tests passing

## Phase 3: Framework Integration

### Objectives
- Improve Express adapter with full type preservation
- Create Angular adapter with interceptor support
- Ensure all Schmock features work seamlessly with frameworks

### Planned Tasks

#### 3.1 Express Adapter Improvements
- [ ] Preserve Schmock error types through Express
- [ ] Add middleware composition support
- [ ] Enable Express-specific plugins
- [ ] Add request/response streaming support

#### 3.2 Angular Adapter
- [ ] Create `@schmock/angular` package
- [ ] Implement HTTP interceptor
- [ ] Support Angular's HttpClient
- [ ] Add RxJS integration
- [ ] Create Angular-specific examples

#### 3.3 Framework Testing
- [ ] Integration tests for each adapter
- [ ] Performance benchmarks
- [ ] Real-world usage examples
- [ ] Framework-specific documentation

## Phase 4: Documentation and Polish

### Objectives
- Comprehensive documentation for all features
- Migration guides for breaking changes
- Performance optimization
- Developer experience improvements

### Planned Tasks

#### 4.1 Documentation
- [ ] API reference for all packages
- [ ] Plugin development guide
- [ ] Framework integration guides
- [ ] Performance best practices
- [ ] Troubleshooting guide

#### 4.2 Developer Experience
- [ ] CLI tool for project setup
- [ ] VSCode extension for route completion
- [ ] Schema validation in IDE
- [ ] Debug mode with detailed logging

#### 4.3 Performance
- [ ] Bundle size optimization
- [ ] Lazy loading for plugins
- [ ] Response caching strategies
- [ ] Memory usage profiling

## Implementation Timeline

- **Phase 1**: ✅ Completed
- **Phase 2**: In Progress (Est. 2-3 days)
- **Phase 3**: Next (Est. 3-4 days)
- **Phase 4**: Final (Est. 2-3 days)

## Breaking Changes

### Phase 1
- Plugin API location changed (must import from builder)
- Error types are now specific classes instead of generic Errors
- Build output strictly goes to `dist/` directories

### Phase 2 (Planned)
- Schema plugin will be integrated into builder
- Plugin hooks will change signatures
- Route definitions may have new required fields

## Success Metrics

- ✅ All TypeScript compilation errors resolved
- ✅ Consistent build process across packages
- ✅ No generated files in source directories
- ⏳ All BDD tests passing
- ⏳ Framework adapters with full type safety
- ⏳ Comprehensive documentation
- ⏳ Active plugin ecosystem

## Notes

- Each phase builds upon the previous one
- Testing is performed continuously at each phase
- Breaking changes are minimized where possible
- Community feedback incorporated throughout