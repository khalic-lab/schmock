# Changelog

## 1.0.0 (2025-08-01)


### ⚠ BREAKING CHANGES

* Major architectural improvements with the following changes:

### Features

* add BDD feature for event system ([6892fb1](https://github.com/khalic-lab/schmock/commit/6892fb197e603f044371b75e5364b339f97ed0ec))
* add comprehensive failure scenarios for schema generation ([ebdbb4d](https://github.com/khalic-lab/schmock/commit/ebdbb4d628f0a41f3ed23708b9f6d488ac789044))
* add comprehensive failure scenarios for schema generation ([d276330](https://github.com/khalic-lab/schmock/commit/d27633042bad25023bd2ae8ca8d416077010e586))
* add E2E test infrastructure and Express adapter ([c3303d7](https://github.com/khalic-lab/schmock/commit/c3303d70ec9f50fe9159afd5053d4b213c1dbbd5))
* add E2E test infrastructure and Express adapter ([855df81](https://github.com/khalic-lab/schmock/commit/855df81d3a7076f8ef65c44495a9d6969d9ca73b))
* add E2E test infrastructure and Express adapter ([2957d65](https://github.com/khalic-lab/schmock/commit/2957d65073a90ae4efaef23b21183fdedb52bb84))
* add event system to builder and remove legacy core package ([73594c5](https://github.com/khalic-lab/schmock/commit/73594c58f3b5a711c7a8e453f033b96d48dbe54f))
* add JSON Schema-based automatic data generation system ([419d1a4](https://github.com/khalic-lab/schmock/commit/419d1a4894e40292a631e46609d64dfb3221b43c))
* add JSON Schema-based automatic data generation system ([85a0b5b](https://github.com/khalic-lab/schmock/commit/85a0b5b616ff6a81092b9a73d272a5b1bf09b28e))
* complete Phase 1 - core architecture improvements ([4f5fdcb](https://github.com/khalic-lab/schmock/commit/4f5fdcba036f2aad56b1e207a2dc2d31e2e4254a))
* complete Phase 3 & 4 - plugin system and framework integration ([0f27e91](https://github.com/khalic-lab/schmock/commit/0f27e915dae8a581939f7b7b2a60d4d2659a4c53))
* implement basic Schmock class with static GET mocking ([3bd21af](https://github.com/khalic-lab/schmock/commit/3bd21af12af9fe5fc2037cab5499cc610ad5d3e1))
* implement complete event system for plugin architecture ([ec4e306](https://github.com/khalic-lab/schmock/commit/ec4e30602a76f19bc5e9d2983e0d755b2bf5097f))
* implement comprehensive debug mode with full documentation ([a0110d3](https://github.com/khalic-lab/schmock/commit/a0110d32b807cfd9ce4c116e3f2538a9e380cc9e))
* implement fluent API builder with TDD ([17f83ef](https://github.com/khalic-lab/schmock/commit/17f83ef7be4199868ca359bb6b23977139c15cbb))
* implement fluent API builder with TDD ([e6482c2](https://github.com/khalic-lab/schmock/commit/e6482c2479352a6f62ff74763f7039e9bd7aa14c))
* implement POST, PUT, DELETE, and PATCH HTTP methods ([01ba0b6](https://github.com/khalic-lab/schmock/commit/01ba0b6ba90b0b1dd00c9fc744e37e4ef938b70f))
* implement POST, PUT, DELETE, and PATCH HTTP methods ([cc5c514](https://github.com/khalic-lab/schmock/commit/cc5c514af80182bfe306f2aec0c2e443c71fe4f1))
* initial schmock setup with BDD testing ([fee32fd](https://github.com/khalic-lab/schmock/commit/fee32fdfa1275ba6153225c291bd789c4569a2f6))
* Rebuild CI from scratch with simplified, robust design ([c245d2e](https://github.com/khalic-lab/schmock/commit/c245d2e013c984dbcdfcc83946f75096192a5f5d))
* simplify type definitions and remove unused types ([ce51659](https://github.com/khalic-lab/schmock/commit/ce5165948c5147c1f6d4ffb645ef1faeeca4d76c))


### Bug Fixes

* add tsbuildinfo to gitignore and remove from tracking ([cff23f1](https://github.com/khalic-lab/schmock/commit/cff23f17df7a38f75b84597062d5acb0cf133a3c))
* apply automatic lint fixes for formatting and style ([3a6c829](https://github.com/khalic-lab/schmock/commit/3a6c8293339c5ac2c13e885003e72ac515d4cfd5))
* apply biome auto-fixes for express package formatting and imports ([404dc8c](https://github.com/khalic-lab/schmock/commit/404dc8c26aa3932b3b9fcc0c6829f994ba14acd9))
* Apply linter formatting to express package ([e4b13e8](https://github.com/khalic-lab/schmock/commit/e4b13e8ca1121e1b022eaed5873617235a540087))
* build issue ([556bbac](https://github.com/khalic-lab/schmock/commit/556bbac9fc895f78cb815658c9bc365b478c3b31))
* Build packages before running tests in CI ([e40565b](https://github.com/khalic-lab/schmock/commit/e40565bba219885f34f4c01b2245bfe1ce069722))
* configure biome to allow any types with warning instead of error ([361575e](https://github.com/khalic-lab/schmock/commit/361575e5e3c41624d38132da719b646ea2a91fe8))
* configure biome to allow necessary any types and fix remaining lint issues ([6f46ab4](https://github.com/khalic-lab/schmock/commit/6f46ab40e81f0333330bbd68180022b6ddf6397d))
* Configure release-please for GitHub CI compatibility ([cfbfc24](https://github.com/khalic-lab/schmock/commit/cfbfc24d86be5165f3a15def55e011d55e09c1a1))
* correct BDD step definitions to match literal feature strings ([2ba59c0](https://github.com/khalic-lab/schmock/commit/2ba59c0bf2e89df32db233f97e487d04481d5897))
* correcting build issue ([281736d](https://github.com/khalic-lab/schmock/commit/281736d4baa2534dbf8c32bc41c9facea0a663f1))
* disable canary releases until ready to publish ([1929f43](https://github.com/khalic-lab/schmock/commit/1929f4397c85b8440b120bbf73c5fa7e6bb1e083))
* Fix linting errors and revert debug changes ([bd31ed7](https://github.com/khalic-lab/schmock/commit/bd31ed724fec8de2f7fa880e7a600a29f959840f))
* Force clean workspace in CI to prevent stale cached files ([4cede15](https://github.com/khalic-lab/schmock/commit/4cede15e481fb2bc821ba91f3f178e1f4ef0ebf8))
* regenerate bun.lock for CI consistency ([7cd2dc2](https://github.com/khalic-lab/schmock/commit/7cd2dc263312f29113154b23502eae3bab7fdd35))
* removed old files ([36de337](https://github.com/khalic-lab/schmock/commit/36de337a89d4efb96531c122f89f63d35d6df801))
* removed old files ([f887924](https://github.com/khalic-lab/schmock/commit/f887924115ae255b1d9503e4859158416cbe04cf))
* replace any type with unknown in eventHandlers ([59997fc](https://github.com/khalic-lab/schmock/commit/59997fc3f2d5b8aa15463500c10e442105002ea5))
* resolve all lint issues ([60a98eb](https://github.com/khalic-lab/schmock/commit/60a98ebe63e941c4c2b4782560676d9d4698c2d6))
* resolve CI build failures with proper dependencies and typing ([5f75391](https://github.com/khalic-lab/schmock/commit/5f75391d0d06a042ca01eb3e37f8c3d36e296496))
* resolve CI build failures with proper dependencies and typing ([7f5ba58](https://github.com/khalic-lab/schmock/commit/7f5ba58e0c11bdd2797f4a1d4be66a6c2ac89812))
* resolve merge conflicts and restore event system implementation ([59b64b8](https://github.com/khalic-lab/schmock/commit/59b64b8d39fe0667f26fa9dd2b6d3b28cad09640))
* resolve remaining lint issues across all packages ([24b6e3f](https://github.com/khalic-lab/schmock/commit/24b6e3f7bc53b6ac14489d572f5aefde6e223254))
* resolve TypeScript and linting issues in builder package ([08fec62](https://github.com/khalic-lab/schmock/commit/08fec62d60ac283b9e58d798271dff934d11a1f9))
* Resolve TypeScript compilation errors across all packages ([bacf692](https://github.com/khalic-lab/schmock/commit/bacf692021f81fb7f777f6a8091afa9a625735fc))
* Resolve TypeScript compilation errors in CI build ([a2f5228](https://github.com/khalic-lab/schmock/commit/a2f522869933e3398d074aae78b2c1295bb35738))
* resolve TypeScript namespace conflicts and add documentation ([2f1ea71](https://github.com/khalic-lab/schmock/commit/2f1ea714f65bfe1b56c2fc17719d5f4bc9078691))
* Resolve TypeScript type errors across all packages ([e6fd690](https://github.com/khalic-lab/schmock/commit/e6fd690e92d5f12be8b43e44b23073f00b9eb1e2))
* Run typecheck in correct dependency order in CI ([f7151d5](https://github.com/khalic-lab/schmock/commit/f7151d56524164c50a947fb07075d2525f38d6cd))
* Simplify PR comment job in CI workflow ([e221451](https://github.com/khalic-lab/schmock/commit/e221451d7b4ae44d88b979bdfe06d1d86206b5a2))
* **tests:** Correct failing BDD test for debug mode ([8dc3799](https://github.com/khalic-lab/schmock/commit/8dc379992b6062a618bb5f72fdce8cba958fa884))
* Update CI to force clean builds and fix cache issues ([2bb4da5](https://github.com/khalic-lab/schmock/commit/2bb4da5e49ab20736420cbd5062119f4e87b1721))
* update CI workflows to run on develop branch PRs ([1d8aed3](https://github.com/khalic-lab/schmock/commit/1d8aed321d632ec6cd041119da9c8711f42d1baf))
* update CI/CD setup and fix BDD test syntax ([5fe6efc](https://github.com/khalic-lab/schmock/commit/5fe6efc5ada7e5a01a6dbc69982377d16cc54023))
* update unit test to use vitest instead of bun:test ([23078cf](https://github.com/khalic-lab/schmock/commit/23078cf15070e80f9b3eb19f6ac230fea35603a1))
