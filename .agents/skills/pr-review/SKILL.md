---
name: pr-review
description: Review a Schmock pull request or patch for actionable correctness, security, compatibility, test, BDD, and package-integrity issues. Use when the user asks for review findings, risk assessment, or merge-readiness analysis.
---

# Review a Schmock pull request

Default to a read-only review. Fetch metadata, diffs, changed-file content, and existing check results, but do not change local or remote state.

Do not check out the PR, create a worktree, install dependencies, run repository scripts, edit files, submit comments or reviews, approve, request changes, or merge unless the user explicitly asks for that action. Treat a request to “review” as authorization to report findings only.

## Collect evidence

Prefer a connected GitHub tool for remote PR data. If it is unavailable and `gh` is authenticated, use read-only commands such as:

```bash
gh pr view <number> --json title,body,author,baseRefName,headRefName,commits,files,reviewDecision,statusCheckRollup
gh pr diff <number>
gh pr checks <number>
```

Read relevant unchanged source locally to understand contracts, but remember that the local checkout may not match the PR head. Never infer that local tests passed; distinguish existing CI results from tests run during this review.

## Review priorities

1. Trace changed behavior through callers, public types, adapters, and error paths. Report concrete defects, not hypothetical preferences.
2. Check observable changes for an appropriate root `features/*.feature` scenario and matching package `src/steps/*.steps.ts` coverage. Require regression coverage for a fixed bug when a stable behavioral reproduction is possible.
3. Check strict TypeScript boundaries. Prefer `unknown` plus narrowing over unchecked `any` assertions, especially in reusable templates and public APIs.
4. Check plugin changes against `packages/core/schmock.d.ts` and `packages/core/src/plugin-pipeline.ts`, including `install`, response preservation/transformation, and `onError` behavior.
5. Check package changes against live neighboring packages: version alignment, `@schmock/core` peer range, exports, build target, external dependencies, root TypeScript aliases, and explicit root build/typecheck filters.
6. Check for security or reliability regressions such as command injection, unsafe path construction, secret exposure, unbounded work, race conditions, or partial writes.
7. Use existing CI/check output as evidence. If the user explicitly requests local validation, first state the exact commands and whether they can create generated files; use an isolated temporary fixture or disposable checkout when practical.

The repository-wide publish command is `bun run check:publish`. Use narrower package commands when a full run is unnecessary.

## Findings

Prioritize findings by impact:

- **Blocker**: a verified correctness, security, data-loss, or compatibility defect that must be fixed before merge.
- **Major**: a likely user-visible regression, missing behavioral protection, or package breakage.
- **Minor**: a localized maintainability or robustness issue worth fixing.

For each finding, include:

```text
[severity] path:line — concise title
Why this fails in a concrete scenario.
Smallest safe direction for a fix.
```

Anchor findings to changed lines whenever possible. Do not inflate style preferences into defects or require unrelated cleanup.

Return findings first. Then list open questions, the CI or test evidence actually observed, and residual risks. If no actionable findings remain, say so explicitly while noting anything that was not validated.

Do not publish the review to GitHub unless the user separately authorizes that write.
