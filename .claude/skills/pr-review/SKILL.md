---
name: pr-review
description: >
  Review pull requests against Schmock project standards. Checks BDD coverage,
  code quality, conventions, and documentation. Use when asked to review a PR,
  check whether a branch meets project standards before merging, or assess BDD
  test coverage on a change.
argument-hint: "[pr-number]"
---

# Schmock PR Review Skill

## Review Checklist

### BDD Coverage

- [ ] Every new feature has corresponding `.feature` scenarios
- [ ] Every bugfix has a regression scenario
- [ ] Step definitions (`.steps.ts`) exist and match their `.feature` files
- [ ] No orphaned `.feature` files without step definitions

### Code Quality

- [ ] TypeScript strict mode — no `any` abuse, proper generics
- [ ] No unnecessary comments or dead code
- [ ] Follows existing codebase patterns and conventions
- [ ] No over-engineering or premature abstractions
- [ ] No security vulnerabilities (injection, XSS, etc.)

### Testing

- [ ] Unit tests for complex internal logic
- [ ] BDD tests for behavioral contracts
- [ ] No test regressions — all existing tests still pass
- [ ] Coverage is adequate for changed code

### Commits

- [ ] Conventional commit format: `feat:`, `fix:`, `chore:`, etc.
- [ ] Clear, descriptive commit messages
- [ ] Logical commit history (not too granular, not too big)

### Package Integrity

- [ ] `bun check:publish` passes (publint + attw)
- [ ] No unintended dependency changes
- [ ] Peer dependency ranges are appropriate
- [ ] Exports are correct in `package.json`

## Review Workflow

1. **Get the PR diff:**
   ```bash
   gh pr diff <number>
   ```

2. **Check PR details:**
   ```bash
   gh pr view <number>
   ```

3. **Review behavioral changes:**
   - Look for added/modified `.feature` files
   - For each behavioral change, verify BDD coverage
   - Check that step definitions match scenarios

4. **Review code changes:**
   - Check TypeScript patterns and types
   - Verify error handling
   - Look for security issues
   - Check for unnecessary complexity

5. **Run tests on the branch:**
   ```bash
   gh pr checkout <number>
   bun test:all
   ```

6. **Provide structured feedback** using severity levels

## Reviewing a Dependency Bump

A bump that moves the formatter or the linter rewrites files wholesale. The
diff arrives with hundreds of changed lines that mean nothing, and that is
exactly where a real edit hides — "it's just the formatter" looks identical to
"it's mostly the formatter". Do not read that diff by eye.

### 1. Separate reflow from edits, mechanically

Re-run the **new** formatter over the **old** content and compare against what
was committed. Byte-identical means reflow and nothing else.

```bash
bash .claude/skills/pr-review/scripts/check-formatter-only.sh <base> <head> '*.ts'
```

Exit 0 means every changed file reproduces from its old content. Exit 1 lists
the files that do not — those are the only ones worth reading. Override the
formatter with `FORMATTER_CMD` (default `bunx biome format`).

Run this **before** reading any dep-bump diff. On `828a82e..e0ea864` it reduced
494 changed lines across 9 files to a single file that needed human eyes.

### 2. Do not let a green suite stand in for the check

If the bump changed a library's output and the assertions were adjusted to
match, the suite passes by construction. A green run says nothing about whether
the tests still test what they used to. The formatter check above is what
distinguishes reflow from a weakened assertion.

### 3. Check the commit *after* the bump too

Lint rules that tighten in a bump produce follow-up edits, and those edits tend
to land in whatever commit comes next — often a release commit. Two things to
verify:

- [ ] A commit that says "bump versions" contains **only** version bumps.
      Diff it and confirm: `git show <ref> --stat`
- [ ] Every cast removed to satisfy a new lint rule is **behavior-preserving**.
      Silencing a type error by changing what a function returns is the failure
      mode to look for. Restore the original line, confirm it still trips the
      rule, then find a fix that keeps the behavior — a scoped disable with a
      comment is legitimate when the type genuinely cannot be expressed.

### 4. Verify the build, not just the tests

`0.x` dependencies ship breaking changes in minor bumps. Run the build and the
reproducibility check, which the test suite does not cover:

```bash
bun run build && node scripts/check-build-reproducibility.mjs
```

## Severity Levels

| Level | Meaning | Action |
|-------|---------|--------|
| **Blocker** | Must fix before merge | Breaks functionality, missing tests, security issue |
| **Suggestion** | Should consider | Better approach exists, potential improvement |
| **Nit** | Style preference | Naming, formatting, minor readability |

## Feedback Format

Structure review comments as:

```
**[Blocker/Suggestion/Nit]** filename:line

Description of the issue.

Suggested fix (if applicable).
```

## Common Review Issues

1. **Missing BDD scenario** — New feature without `.feature` coverage
2. **Step mismatch** — `.steps.ts` doesn't match `.feature` exactly
3. **Type `any` overuse** — Should use proper types or generics
4. **Missing error handling** — Plugin or adapter doesn't handle edge cases
5. **Breaking change** — Public API change without version bump
