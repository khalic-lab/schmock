---
name: package-generator
description: >
  Scaffold a new @schmock/* package with full monorepo structure. Creates
  package.json, tsconfig, vitest configs, entry point, and registers in workspace.
argument-hint: "<package-name>"
disable-model-invocation: true
allowed-tools:
  - Bash(bun .claude/skills/package-generator/scripts/generate.ts *)
---

# Schmock Package Generator Skill

## Package Anatomy

Every `@schmock/*` package needs these files:

```
packages/<name>/
  package.json          # Name, version, exports, scripts, peer deps
  tsconfig.json         # Extends root, NodeNext module resolution
  vitest.config.ts      # Unit test config
  vitest.config.bdd.ts  # BDD test config
  src/
    index.ts            # Entry point with exports
```

### package.json

Based on the express/angular adapter pattern:
- `"type": "module"` — ESM only
- Exports: `"."` with `types` and `import` conditions
- Scripts: `build`, `build:lib`, `build:types`, `test`, `test:bdd`, `lint`, `check:publish`
- Build: `bun build --minify` for JS, `tsc` for declarations
- Peer dep on `@schmock/core: ^1.0.0`
- Dev deps: `vitest`, `@amiceli/vitest-cucumber`, `typescript`

### tsconfig.json

Extends root config with package-specific overrides:
- `module: "NodeNext"`, `moduleResolution: "NodeNext"`
- `rootDir: "./src"`, `outDir: "./dist"`
- Excludes: `*.test.ts`, `*.steps.ts`
- References `../core`

### vitest.config.ts (unit)

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.steps.ts"],
  },
});
```

### vitest.config.bdd.ts

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.steps.ts"],
    reporters: [['default', { summary: false }]],
  },
});
```

## Registration

After generating the package, these files need updating:

1. **Root `tsconfig.json`** — Add path alias: `"@schmock/<name>": ["packages/<name>/src"]`
2. **Root `package.json`** — Add to `build` and `typecheck` scripts

The generate script handles tsconfig registration automatically.

## Conventions

- Build: `bun build --minify` for JS output + `tsc` for type declarations
- ESM-only output (no CJS)
- Strict TypeScript (inherited from root config)
- Author: `Khalic Lab`, License: `MIT`

## Post-Generation Steps

After scaffolding a new package:

1. Create a `.feature` file for the package behavior (`/development scaffold <name> <pkg>`)
2. Add to CI workflow matrix if needed (`.github/workflows/`)
3. Install any specific dependencies: `bun add -D <dep> --cwd packages/<name>`
4. Start implementing!

## Command

```
/package-generator <name>
```

Example:
```
/package-generator fastify
```

Creates `packages/fastify/` with full structure and registers it in the workspace.
