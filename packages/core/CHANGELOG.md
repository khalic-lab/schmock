# Changelog

## [1.4.0](https://github.com/khalic-lab/schmock/compare/core-v1.3.0...core-v1.4.0) (2026-02-08)


### Features

* add @schmock/openapi plugin — auto-register routes from OpenAPI specs ([a7b1fd5](https://github.com/khalic-lab/schmock/commit/a7b1fd5bc1bfd866875bb0786e1f0ae32eebca95))
* add comprehensive BDD tests for error handling and async support ([5998093](https://github.com/khalic-lab/schmock/commit/5998093e5536f2132ebabe2dc7ce314d1d3adcbd))
* add comprehensive developer experience BDD tests and fix route precedence ([013488e](https://github.com/khalic-lab/schmock/commit/013488ea8a5214322369041651845dd1bff3ee34))
* add comprehensive HTTP methods BDD tests and fix tuple response handling ([dfa2a09](https://github.com/khalic-lab/schmock/commit/dfa2a093b6a6483295edf3ed814993ef4e6db5c8))
* add comprehensive state concurrency BDD tests ([510360c](https://github.com/khalic-lab/schmock/commit/510360c1d5d4b711f75317a56a712f82216e2f59))
* add comprehensive unit tests and enhance core functionality ([f8ba982](https://github.com/khalic-lab/schmock/commit/f8ba9824d84800d41c023af60165e1bfe393e718))
* add pre-commit hooks for automated linting and testing ([ee4eec8](https://github.com/khalic-lab/schmock/commit/ee4eec845ff3df9f3882588bda0f70a35d9dd1f5))
* add publint and attw checks for package validation ([8bf7378](https://github.com/khalic-lab/schmock/commit/8bf73783dd5e66e33b63f4137d1a9ce6cc275db0))
* add quiet/silent scripts, property-based tests, fix schema BDD ([61ba6f9](https://github.com/khalic-lab/schmock/commit/61ba6f92f677a8d66aab37ecf0e3ed2b702c66a3))
* add standalone server (.listen/.close) and @schmock/cli package ([724f154](https://github.com/khalic-lab/schmock/commit/724f154bb9e68fd9c4e8d3cc45010c4ad15450df))
* evaluate BDD docStrings as real code via evalMockSetup ([4be7201](https://github.com/khalic-lab/schmock/commit/4be720139d21218362e39c660f5fe7fe51f99f0d))
* Phase 2 — request spy, validation/query plugins, zero unsafe type assertions ([e7ce38f](https://github.com/khalic-lab/schmock/commit/e7ce38f02aadfcd6b0a296f98739ab3555f12cc3))


### Bug Fixes

* clean up type system and improve test coverage ([3836024](https://github.com/khalic-lab/schmock/commit/3836024e17a4ee42f2f5ec5e9374fe54d3c6b134))
* code review fixes across all packages ([bdea8d0](https://github.com/khalic-lab/schmock/commit/bdea8d09e873dffbaed20bf53f78bfec510dbb77))
* code review fixes across all packages ([48ee390](https://github.com/khalic-lab/schmock/commit/48ee3901beb22f96976cf218e0bd82a80bf965f5))
* **core,validation:** harden status tuple detection to prevent numeric array misinterpretation ([ed66716](https://github.com/khalic-lab/schmock/commit/ed66716ec45aaa6de17c3962f68be3b100895326))
* **core:** handle Error return from onError plugin hook ([2f3f843](https://github.com/khalic-lab/schmock/commit/2f3f843d5258719eb8968973565549fc325c66c0))
* **core:** match routes in registration order instead of reverse order ([#326](https://github.com/khalic-lab/schmock/issues/326)) ([8da48cb](https://github.com/khalic-lab/schmock/commit/8da48cbd9f1cba71a9f0ca3bde0c521f55265af2))
* **core:** match routes in registration order instead of reverse order ([#326](https://github.com/khalic-lab/schmock/issues/326)) ([bebc3c1](https://github.com/khalic-lab/schmock/commit/bebc3c14ae29e2347c5b4fb10775caecdd0421d9))
* remove flaky performance tests to prevent intermittent failures ([56425d5](https://github.com/khalic-lab/schmock/commit/56425d534334cf9309e883be0f599d32454c26d7))
* remove Schmock namespace, use direct type imports ([5e79ed3](https://github.com/khalic-lab/schmock/commit/5e79ed340bbe3dd706bb933234c3e603b08c669d))


### Performance Improvements

* **core:** add static route Map for O(1) lookup ([ea3ee0f](https://github.com/khalic-lab/schmock/commit/ea3ee0f944d24253ec38f7ce5800d481a0d30dbf))


### Documentation

* add JSDoc to builder internal methods ([3ed36d9](https://github.com/khalic-lab/schmock/commit/3ed36d9a572299ec74254cf40600195bdb1e0394))
