# Not a package

This directory exists so that `@schmock/openapi/browser` resolves under
TypeScript's legacy `moduleResolution: "node"`, which predates `exports` and
looks for a directory with a `package.json` instead. Everything else — every
bundler, and Node itself — reaches the same file through the `exports` map in
the parent `package.json` and never looks in here.

The browser build is documented in `docs/openapi.md`, under "Running in a
browser". You almost certainly do not need to import this path explicitly: the
`browser` export condition selects it automatically.
