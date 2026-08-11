---
name: package-generator
description: Scaffold a new version-aligned @schmock/* workspace package from the repository's current package and toolchain versions. Use only when the user explicitly invokes $package-generator to preview or create a package.
---

# Generate a Schmock package

1. Confirm the requested package name uses lowercase letters, digits, and hyphens and starts with a letter.
2. Choose the build target from the package's runtime: `node` for server-only packages or `browser` for browser-compatible packages. Do not guess when the intended runtime is unclear.
3. Preview the operation without writing:

   ```bash
   bun .agents/skills/package-generator/scripts/generate.ts <name> --target <node|browser> --dry-run
   ```

4. Summarize the files, target, and root alias that the preview reports. Stop after the preview unless the user requested creation.
5. When creation is authorized, rerun without `--dry-run`:

   ```bash
   bun .agents/skills/package-generator/scripts/generate.ts <name> --target <node|browser>
   ```

The generator validates that it is operating in the Schmock repository, reads
the current `@schmock/core` and root toolchain versions, requires all existing
workspace versions to match core, and requires every manifest to have an exact
matching `bun.lock` workspace record and resolution with no stale extras. It
then adds the package, TypeScript path alias, lock workspace record, and lock
workspace resolution transactionally. Dry-run is byte-identical and entirely
offline. Writes reject stale snapshots, use same-directory atomic operations,
and roll back only content still owned by the failed transaction. The generator
does not install dependencies or edit explicit root build, typecheck, smoke, or
release topology.

After generation:

- Resolve every explicit topology follow-up printed by the generator, including
  root build/typecheck filters and the guarded release package order.
- Verify package-specific external dependencies instead of assuming `@schmock/core` is the only external.
- Add behavior-first `.feature` scenarios and matching step definitions when the package changes observable behavior.
- Run the narrowest relevant package typecheck and tests before expanding to repository-wide validation.

Do not overwrite an existing package or bypass a failed dry run.
