---
name: development
description: >
  Schmock development conventions and BDD-first workflow. Use when implementing
  features, fixing bugs, writing tests, or making any code changes. Covers BDD
  scenario authoring, step definitions, project structure, and clean code practices.
argument-hint: "scaffold <name> <package> | repro <name> <package> | start <branch>"
allowed-tools:
  - Bash(bun .claude/skills/development/scripts/scaffold.ts *)
  - Bash(bash .claude/skills/development/scripts/start.sh *)
---

# Schmock Development Skill

## Project Structure

Monorepo with 8 packages under `packages/`:

| Package | Purpose | Peer Deps |
|---------|---------|-----------|
| `@schmock/core` | Callable mock API, routing, plugin pipeline | — |
| `@schmock/faker` | Faker-powered automatic data generation plugin | `@schmock/core` |
| `@schmock/express` | Express middleware adapter | `@schmock/core`, `express` |
| `@schmock/angular` | Angular HTTP interceptor adapter | `@schmock/core`, `@angular/core`, `@angular/common`, `rxjs` |
| `@schmock/validation` | Request/response JSON Schema validation | `@schmock/core` |
| `@schmock/query` | Pagination, sorting, filtering for arrays | `@schmock/core` |
| `@schmock/openapi` | Auto-register routes from OpenAPI specs | `@schmock/core`, `@schmock/faker` |
| `@schmock/cli` | Standalone CLI server from OpenAPI specs | `@schmock/core`, `@schmock/openapi` |

Key locations:

```
features/              # Gherkin .feature files (all packages share this)
packages/*/src/        # Source code per package
packages/*/src/steps/  # BDD step definitions per package
packages/core/schmock.d.ts  # Ambient type declarations
```

## BDD Conventions

### Feature Files (`features/*.feature`)

Rules:
- **No** `Scenario Outline`, `Background`, or data tables — keep scenarios self-contained
- Each Scenario has its own Given/When/Then chain
- Use DocStrings (triple-quoted blocks) for code snippets and JSON payloads
- Feature description uses "As a / I want / So that" format

Example:

```gherkin
Feature: Callable API
  As a developer
  I want to define mocks using a direct callable API
  So that I can create readable and maintainable mocks

  Scenario: Simple route with generator function
    Given I create a mock with:
      """
      const mock = schmock({})
      mock('GET /users', () => [{ id: 1, name: 'John' }], {})
      """
    When I request "GET /users"
    Then I should receive:
      """
      [{ "id": 1, "name": "John" }]
      """
```

### Step Definitions (`packages/*/src/steps/*.steps.ts`)

1:1 mapping — each `.feature` file has a corresponding `.steps.ts` in the implementing package.

Pattern:

```typescript
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { MockInstance } from "../types";

const feature = await loadFeature("../../features/<name>.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: MockInstance<any>;
  let response: any;

  Scenario("Scenario name from .feature", ({ Given, When, Then, And }) => {
    Given("step text", (_, docString: string) => {
      // setup
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });
});
```

Key conventions:
- `loadFeature()` uses relative path from the steps file: `../../features/<name>.feature`
- Step functions receive `(_: undefined, ...args)` — first param is always ignored
- DocString comes as the last parameter: `(_, docString: string)`
- Cucumber expressions: `{string}`, `{int}`, `{float}` for parameter extraction
- `When` steps are `async` when calling `mock.handle()`
- Shared state (mock, response) declared in `describeFeature` closure scope

## TDD Workflows

### Unit TDD (Red → Green → Refactor)

1. Write a failing `.test.ts` that describes the expected behavior
2. Run `bun test:unit` — test fails (Red)
3. Implement the minimum code to make it pass
4. Run `bun test:unit` — test passes (Green)
5. Refactor while keeping tests green

### BDD TDD (Scenario → Steps → Implementation)

1. Write `.feature` scenario describing the desired behavior
2. Write `.steps.ts` with step implementations
3. Run `bun test:bdd` — steps fail (Red)
4. Implement the production code
5. Run `bun test:bdd` — steps pass (Green)
6. Refactor while keeping all tests green

### Combined Flow

BDD defines the behavior contract (outside-in), unit tests drive the implementation details (inside-out). **Always start with BDD**, add unit tests for complex internal logic.

## Feature Development Workflow

1. **Check for duplicates first** — run `scaffold --check` to list all existing features and their scenarios
2. **Review the output for semantic overlap** — if an existing feature already covers the behavior you want, add a new Scenario to that feature instead of creating a new one
3. **Write `.feature` file first** — BDD-first!
4. Write `.steps.ts` with step stubs
5. Run BDD tests (`bun test:bdd`) — they fail (TDD red)
6. Implement the code (add unit tests for complex internals)
7. Run all tests (`bun test:all`) — they pass (TDD green)

Use `scaffold` argument to create both files from templates:

```
/development scaffold my-feature core
```

**IMPORTANT — Duplicate Feature Detection:**

Before scaffolding, always run `--check` first:

```
bun .claude/skills/development/scripts/scaffold.ts --check
```

This lists every existing feature with its scenario names and owning package. Review the list for:
- **Exact duplicates** — a feature with the same name already exists
- **Semantic overlap** — an existing feature already covers the same behavior under a different name (e.g., scaffolding `user-auth` when `login-flow` already covers authentication)
- **Scenario fit** — the new behavior might belong as a new Scenario in an existing feature rather than a whole new feature file

If overlap is found, add scenarios to the existing feature instead of creating a new one.

## Bug Reproduction Workflow

1. Add a failing Scenario to the existing `.feature` file
2. Add matching step definition to the `.steps.ts`
3. Run BDD test — confirms the bug (TDD red)
4. Fix the code
5. Run BDD test — confirms the fix (TDD green)
6. Add unit test if the bug was in internal logic

Use `repro` argument to create a bug-specific feature + steps:

```
/development repro fix-route-matching core
```

## Clean Code

- TypeScript strict mode — no `any` unless absolutely necessary
- No unnecessary comments — code should be self-documenting
- Follow existing patterns in the codebase
- Keep functions small and focused
- No over-engineering — minimum complexity for the current task

## Git Workflow

- **Conventional commits**: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- **Branch flow**: `feature/* → develop → main`
- Create feature branch from `develop`:

```
/development start my-feature-name
```

## Commands

| Command | Description |
|---------|-------------|
| `/development scaffold <name> <package>` | Create `.feature` + `.steps.ts` from templates |
| `/development repro <name> <package>` | Same as scaffold, for bug reproduction |
| `/development start <branch-name>` | Create feature branch from develop |
