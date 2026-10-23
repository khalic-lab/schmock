# Not a package

This directory exists so that `@schmock/core/adapter` resolves under
TypeScript's legacy `moduleResolution: "node"`, which predates `exports` and
looks for a directory with a `package.json` instead. Everything else — every
bundler, and Node itself — reaches the same file through the `exports` map in
the parent `package.json` and never looks in here.

The adapter entry is documented in `docs/api.md`, under
"`@schmock/core/adapter`".
