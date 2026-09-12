# pr-review evals

Eval suite for the `pr-review` skill, run with `claude plugin eval`.

## Running

From the skill root (`.claude/skills/pr-review`), not from here:

```bash
cd .claude/skills/pr-review
PATH="/opt/homebrew/bin:$PATH" claude plugin eval . --scaffold --allow-tools Bash
```

Run it with the ablation on — `--ablation with-without` is the default whenever
a plugin resolves, and it is the only mode that answers the question the suite
exists for. Under `--ablation none` the `consulted-the-review-skill` grader is
scored instead of treated as an indicator, which drags the score for a reason
that has nothing to do with review quality.

Both flags are required and neither is a default:

- `--scaffold` runs the case's `scaffold_script`, which builds the throwaway
  git fixture each case reviews. Without it the case runs against an empty
  workspace and every grader fails.
- `--allow-tools Bash` — the reviewer cannot read a commit without `git`.

Useful additions:

| Flag | Why |
|------|-----|
| `--ablation with-without` | The point of the suite — scores the skill against baseline Claude. On by default when a plugin resolves. |
| `--runs 1` | Faster while iterating. Default is 3. |
| `-j 4` | Concurrency. Each run is a full agent on your own credential. |
| `--max-cost-usd 5` | Hard ceiling; aborts and reports partial results. |
| `--json out.json` | Machine-readable scores. |

## Cases

### `dep-bump-formatter-churn`

The regression this suite exists for. A synthetic repo gets a dependency bump
whose formatter narrows the indent width, reflowing all five source files —
~150 changed lines that mean nothing. One behaviour-changing edit rides along
inside that churn: `dereference` starts returning the input `document` instead
of the value `walk()` produced, which diverges whenever the root document is
itself a `$ref`.

This is a scaled-down reconstruction of a real miss in this repo — see
`ad9b881`, where the same shape of edit shipped inside a commit labelled
"Bump all 11 workspaces from 2.4.0 to 2.4.1".

The fixture is self-contained: it ships its own formatter (`tools/format.sh`),
so the mechanical check the skill prescribes reproduces exactly without Biome,
a network fetch, or anything from the parent repo.

**Ground truth**, verified by running both versions of the file:

```
input  {"$ref": "#/target", "target": {"x": 1}}
before {"x": 1}
after  {"$ref": "#/target", "target": {"x": 1}}   <- unresolved
```

Nested `$ref`s — every realistic document — are unaffected, which is exactly
what makes it survive a green test suite.

**Grading.** The two `llm` graders carry the weight, because review findings
have many valid phrasings and a string matcher cannot tell a correct one from a
wrong one. `finds-the-hidden-behaviour-change` (weight 3) wants both the *what*
and the *why*; `no-false-positives-on-reflow` (weight 1) fails a reviewer that
invents defects in the four clean files — the failure mode in the other
direction. The `regex` grader is a cheap floor that only checks the right file
is named; it is deliberately not the discriminator. `consulted-the-review-skill`
is scoped `arm: with-only`, so it reports whether the skill fired without
penalising the baseline arm for not having it.

## Adding a case

```bash
cd .claude/skills/pr-review
claude plugin eval init --bare <name>
```

That writes `prompt.md` + `graders/criteria.md`. A single `case.yaml` is the
richer form — it is the only way to set `scaffold_script`, `runs`, `arm`, and
per-grader weights. Grader types: `regex`, `tool_order`, `tool_used`,
`file_exists`, `llm`, `baseline`.

### Gotchas found by running it

**`git` must come from the operator's shell, and it matters.** `/usr/bin/git`
on macOS is the Xcode shim, which needs to write an `xcrun` cache and cannot
under the eval sandbox — every git command fails. In the first run the reviewer
recovered by decompressing `.git/objects` by hand, which is not the skill being
tested. Prefixing `PATH="/opt/homebrew/bin:$PATH"` fixes it.

Setting it in the case does NOT work: `execution.env` accepts only `EVAL_*`
keys, and anything else is rejected before the first run launches
(`execution.env key "PATH" is not allowed`). Environment beyond `EVAL_*` is
deliberately the operator's to supply.

**Judge a grader by its failures.** The `no-false-positives-on-reflow` criteria
was first written as a prohibition ("score zero if the response claims..."), and
three judges out of three failed a response that plainly complied. Rewritten to
lead with the PASS conditions and to say outright that findings about other
files are irrelevant, it grades correctly. A grader that fails systemically is
usually the thing that is wrong.

**`scaffold_script` is a path, not inline bash.** It names a file relative to
the case directory (here, `scaffold.sh`). Putting the script inline as a YAML
block scalar parses fine and then fails at run time with
`path "set -euo pipefail git init ..."` — the runner opened the whole script as
a filename. The case still loads and the graders still parse, so the only
symptom is every arm erroring with score 0.

## Results

| run | model | with | without | delta | `Skill` invoked |
|-----|-------|------|---------|-------|-----------------|
| 2026-09-12 | opus (session default) | 1.00 | 1.00 | **0** | 0x |
| 2026-09-12 | `--model haiku`, n=1 | 0.40 | 0.40 | **0** | 0x |
| 2026-09-12 | haiku, n=3, widened `description:` | 0.47 | 0.60 | **-0.13** | 1x |
| 2026-09-12 | haiku, n=3, `max_turns: 60` | **1.00** | 0.80 | **+0.20** | 1-2x |

Read the delta only after reading the last column. `consulted-the-review-skill`
is the reason these runs are interpretable: the `with` arm **never called `Skill`**,
so the section under test was never in the model's context. A delta of zero here
means "the skill was not read", not "the skill does not help" — a distinction
the score alone cannot make.

That grader is reported but deliberately NOT scored (`scored: false` in the
JSON). Scoring it would give the two arms different denominators — the baseline
arm has no plugin and structurally cannot pass it — and the delta would stop
measuring content. Its job is to tell you whether the delta is worth reading at
all, which on this run it did.

**Why it did not fire.** The skill's `description:` frontmatter is what a model
matches against, and it offered only *"Review pull requests against Schmock
project standards... Use when asked to review a PR, check whether a branch meets
project standards before merging, or assess BDD test coverage."* The case prompt
asks to review *a commit* — a dependency bump, in a fixture that is not Schmock.
Nothing in the description covers that, so declining to load it was correct
behaviour.

The lesson generalises past this case: **adding a section to a SKILL.md does not
make it reachable.** The body is only read once the description has already won
the match, so prose added for a scenario the description does not name is dead
weight in exactly the scenario it was written for. Widen the description in the
same change, or the new section is unreachable.

**Run it at a tier with headroom.** The two rows above fail to discriminate for
opposite reasons, and both are saturation rather than signal. At opus the case
is solved unaided — both arms score 1.00, so the `with` arm has nowhere to go
even once the skill loads. At haiku both arms sit at 0.40: the weight-3
`finds-the-hidden-behaviour-change` grader fails 3/3 in both, while the cheap
regex floor still matches `deref` — a good illustration of why that grader is
explicitly not the discriminator. Only haiku has room to move, so it is the tier
to measure the delta at; a zero at opus would carry no information either way.

**A skill can cost more turns than the budget allows.** Widening the
`description:` made the skill load — `Skill called 1x` in all three `with` runs
— and the delta went *negative*: 0.47 with, 0.60 without. The per-run turn
counts say why:

| arm | run | turns | score | error |
|-----|-----|-------|-------|-------|
| with | 0 | **31** | 0.20 | `Reached maximum number of turns (30)` |
| with | 1 | **31** | 0.20 | `Reached maximum number of turns (30)` |
| with | 2 | 23 | **1.00** | — |
| without | 0 | 4 | 1.00 | — |
| without | 1 | 21 | 0.40 | — |
| without | 2 | 5 | 0.40 | — |

Two of the three `with` runs hit the turn ceiling and never produced a final
message, which is also why `names-the-offending-file` reports `pattern not found
in last_message` there — there was no last message to match. The one `with` run
that finished scored a clean 1.00.

So the negative delta is a *budget* result, not a quality result: following this
skill's procedure costs a small model more turns than the case allowed. That is
worth knowing on its own — a skill whose procedure does not fit the turn budget
of the model running it is a net loss, however good its advice — but it does not
answer whether the advice helps. `max_turns` is now 60 (and `timeout_seconds`
900) so the two can be told apart.

Two lessons for reading any score here, both learned the expensive way: check
`Skill called Nx` before reading a delta, and check the per-run `error` field
before reading it as quality. An arm that dies on `max_turns` scores low for a
reason that has nothing to do with what is being measured.

### The baseline is noisier than the effect

The `without` arm scored 1.00, 0.40, 0.40 on identical inputs — a spread of
0.60 across three runs of the same prompt. The measured delta was -0.13. **The
noise is more than four times the effect.** At n=3 with this variance the suite
cannot separate "the skill helps" from "the skill hurts" from "nothing
happened", whatever the arithmetic mean says.

Report the spread whenever quoting a delta from this case. A number like
`-0.13` to two decimals reads as a measurement, and at this sample size it is
not one. Raising `--runs` is the fix, at linear cost; until then treat the
deltas above as smoke tests of the harness rather than as evidence about the
skill.

### A grader that passed a wrong answer

The `without` run that scored 1.00 did so in **four turns** — no formatter
replay, nothing executed — and its finding was factually wrong:

> "The function ignores the walk operation's output and returns the input
> unchanged. All `$ref` pointer resolution is broken... making the function a
> no-op."

That is the opposite of true. `walk` mutates in place, so nested and chained
`$ref`s still resolve; the divergence is specific to a root-level `$ref`, which
is exactly why the bug survives a green suite. The model pattern-matched the
diff, got the file right and the mechanism wrong, and three judges passed it.

Two flaws in the criteria let that through, both worth checking in any grader:

- **An accept-list entry that belonged to the other condition.** "The walked
  result is discarded" was listed as valid phrasing for condition 2 (*why it
  matters*), but it is a restatement of condition 1 (*what changed*). The wrong
  answer used that exact phrase, so judges matched it and awarded the point.
- **Three tiers offered to a binary judge.** The criteria said "award full
  credit... award partial credit... award no credit", but the grader resolves to
  PASS/FAIL. A judge told to award partial credit on a two-valued scale rounds
  up.

The criteria now states that it is PASS/FAIL with no partial tier, drops the
misfiled phrase, and fails an answer outright for overstating the breakage —
claiming a no-op, or that all `$ref` resolution is broken. Getting the file
right and the mechanism wrong is not finding the bug.

### What the suite finally measured

Raising `max_turns` to 60 confirmed the previous run was a budget artifact. No
run hit the ceiling, and the delta inverted from -0.13 to **+0.20**:

| arm | turns | scores | pass rate |
|-----|-------|--------|-----------|
| with | 9 / 25 / 31 | 1.00 / 1.00 / 1.00 | **3/3** |
| without | 5 / 6 / 27 | 1.00 / 1.00 / 0.40 | 2/3 |

The mean delta is the weaker half of this result. The stronger half is the
spread: the `with` arm has **zero variance** — three runs, three clean passes,
despite turn counts from 9 to 31 — while the baseline still drops a run. At
n=3 a mean shift of 0.20 against a baseline that ranges 0.40-1.00 is not
separable from noise, but "3/3 versus 2/3, with the passing arm invariant" is
the claim the sample size can carry. State it that way.

Both baseline passes here were *legitimately* correct — one independently found
the `parity.test.ts` corpus gap — so this delta is not an artifact of the lenient
grader described above. The baseline is genuinely capable on this case; the skill
makes it reliable.

The honest summary: this case now discriminates, at one tier, at n=3, on one
case. That is enough to say the section is not dead weight, and not enough to
quantify what it is worth.

### Current state: the description change was reverted

The widened `description:` that produced the `Skill called 1x` rows above was
**reverted** — deliberately, by the repo owner. `SKILL.md` currently advertises
only pull requests and branches:

> Review pull requests against Schmock project standards... Use when asked to
> review a PR, check whether a branch meets project standards before merging,
> or assess BDD test coverage on a change.

So **running this case today reproduces `Skill called 0x` and a delta of zero**,
as in the first two rows. That is the expected result against the current
`SKILL.md`, not a regression in the case or the harness. The `+0.20` row is
reproducible only with the description widened to name commits and dependency
updates.

Which leaves the finding intact and the fix unapplied: the `## Reviewing a
Dependency Bump` section below `description:` is unreachable when the request
is to review a commit, because the description never names one. Anyone widening
it should expect to re-tune `max_turns` at the same time — the section's
procedure costs a small model more turns than the old ceiling of 30 allowed.
