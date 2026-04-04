# Open Questions

### Q1: Manual end-to-end verification with sample apps not completed

The operator asked whether the new adapters had been verified by hand (installing them in a real project, not just running the test suite). The assistant offered to scaffold minimal Vite + React and Vite + Vue example apps under examples/ for this purpose, but the session moved to publish before that happened. Remaining question: should example apps be added to the repo as a permanent verification artifact, or is ad-hoc manual testing sufficient before each release?

### Q2: ~~Should `extractHeaders` normalize header keys to lowercase?~~ — RESOLVED (2026-04-02)

Yes. `extractHeaders` now normalizes all header keys to lowercase in all three code paths (Headers instance, array, plain object), consistent with the Headers Web API. See D22.

### Q3: External TodoMVC app vs inline purpose-built components for integration fixtures — RESOLVED (2026-04-01)

When implementing the shared Todo CRUD baseline, the assistant investigated external TodoMVC packages (e.g. react-todomvc by swyx, which supports pluggable backends) as the app source. It noted risks: version pinning, API mismatch, coupling to an external project's evolution. Recommended keeping the inline minimal components (~50 lines each) that test exactly what schmock needs. The operator had not yet responded at session end.


**Resolution:** Operator confirmed inline purpose-built components (~50 lines each). External TodoMVC packages (react-todomvc etc.) were rejected due to version pinning risks, API mismatch potential, and coupling to an external project's evolution. Each adapter fixture now ships its own minimal inline Todo component that tests exactly what schmock needs.

### Q4: Should integration fixtures include 'getting started' tests that copy-paste docs examples

The assistant proposed complementing the Todo CRUD baseline with per-adapter tests that mirror the exact getting-started code from the schmock docs verbatim. If a docs example breaks, the test would fail — enforcing that docs and implementation stay in sync. Offered as an alternative framing alongside the TodoMVC question. Not accepted or rejected by the operator before the session ended.
### Q5: Should a dedicated type-quality review be run (duplicate types, inline types, unsafe `as`)? — RESOLVED (2026-04-04)

Operator raised the question of whether to run a broader type-system code review targeting: duplicate type definitions across packages, inline/anonymous types that should be named, and unsafe `as` type assertions. Related to deferred AUDIT.md items T1–T9 but would go further into structural type hygiene. Not yet accepted or rejected.

**Resolution:** Operator accepted with 'Good idea before publish.' Parallel agents were dispatched to scan the full codebase for type hygiene issues: duplicate type definitions across packages, inline/anonymous types that should be named, and unsafe `as` assertions. Results had not been returned at session end — the scan was in flight when the session closed.
