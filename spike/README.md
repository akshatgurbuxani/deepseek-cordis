# Spikes

This directory is the laboratory for understanding Cordis and testing the assumptions behind a composable agent harness. A spike is evidence for a decision, not an early production module.

## Required contents

Use a numbered directory so the intended learning order is visible:

```text
spike/
└── NNN-short-topic/
    ├── README.md
    ├── src/
    └── test/
```

Each spike README must state:

1. **Question:** one behavior or claim being investigated.
2. **Primary sources:** exact paper revision and section, upstream commit/package version, and relevant source files.
3. **Hypothesis:** the observable result expected before implementation begins.
4. **Boundary:** what state/resources the experiment considers reversible and what lies outside it.
5. **Method:** whether the spike reimplements the mechanism, exercises upstream Cordis, or compares both.
6. **Acceptance criteria:** executable assertions, including failure and teardown behavior.
7. **Result:** commands run, traces or measurements, and deviations from the hypothesis.
8. **Decision:** discard, continue experimenting, depend on upstream, or promote a named behavior into `harness/`.

## Rules

- Pin external revisions. A spike must remain interpretable when the active Cordis and DeepSeek Harness APIs change.
- Keep copied or adapted code attributable and license-compatible.
- Test unload and failure paths, not only successful activation.
- Do not promote code with unresolved resource ownership or irreversible side effects.
- Prefer one narrow lifecycle invariant per spike over a miniature harness that proves nothing clearly.

## Experiments

- [`000-cordis-foundations`](000-cordis-foundations/README.md) defines the research program and foundational invariants.
- [`001-effect-stack`](001-effect-stack/README.md) tests effect ownership, reverse recovery, failure rollback, and nested scopes.
- [`002-dependency-activation`](002-dependency-activation/README.md) tests reactive service resolution and dependency-safe provider replacement.
- [`003-in-flight-transitions`](003-in-flight-transitions/README.md) tests stale-transition prevention and convergence under overlapping dependency mutations.
- [`004-context-isolation`](004-context-isolation/README.md) tests realm-scoped resolution, interception, and mediated-access boundaries.
- [`005-declarative-hmr`](005-declarative-hmr/README.md) tests stable manifest identity, selective reconciliation, and last-known-good rollback.
