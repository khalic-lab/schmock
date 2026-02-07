---
name: pr-review
description: >
  Review pull requests against Schmock project standards. Checks BDD coverage,
  code quality, conventions, and documentation.
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
