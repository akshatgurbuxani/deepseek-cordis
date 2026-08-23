# Spike 005: Declarative reconciliation and transactional HMR

## Question

What is the smallest configuration layer that preserves stable plugin identity
across rereads, changes only the affected live subtree, and restores the
last-known-good composition when loading or activation fails?

## Why this follows Spike 004

Spikes 001–004 established resource ownership, dependency-safe lifecycle
ordering, convergence during in-flight mutation, and realm-scoped resolution.
Components are still added imperatively. The runtime has no configuration
identity and no transaction boundary around loading new code and mutating the
live graph.

## Primary sources

- Paper commit [`948a07b`](https://github.com/cordiverse/paper/commit/948a07b369c62adb3b12e102458be5c18dfb69b9),
  especially Section 5 on the Cordis loader and HMR.
- Upstream Cordis commit [`8cc9e33`](https://github.com/cordiverse/cordis/commit/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4)
  for the pinned lifecycle beneath this experiment.
- DeepSeek Harness commit [`b150a55`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e)
  and its vendored loader and HMR packages.
- DeepSeek's
  [composition and HMR tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/cordis-tutorial/06-composition-and-hmr.md)
  for stable entry IDs, disabled entries, groups, and configuration diffing.

## Hypothesis

A manifest entry needs a stable `id`, a parent relationship, an explicit
`revision`, an enabled flag, and a loader function. The host can preload all
changed modules before mutation, diff by ID and revision, and delegate live
transitions to Spike 004.

If activation fails after mutation begins, compensating reconciliation should
remove candidate fibers and re-add the previous committed components. This
restores composition, though not private in-memory state already disposed.

## Vocabulary and API

- `ManifestEntry`: one desired configuration row.
- `id`: stable identity across rereads.
- `revision`: explicit code/config identity; unchanged means no-op.
- `parentId`: declarative ownership for inherited disabling and subtree removal.
- `EntryHandle`: stable host identity retaining the current component and fiber.
- `DeclarativeHost.reconcile()`: validates, preloads, diffs, applies, settles,
  and commits one configuration transaction.

## Transaction model

```text
validate IDs and parent tree
        ↓
preload changed active modules
        ↓
diff stable IDs and revisions
        ↓
remove absent/disabled entries leaves-first
        ↓
replace changed entries and add new entries
        ↓
settle Spike 004 runtime
        ├── success → commit handles and revisions
        └── failure → remove candidates → restore old components → reject
```

Validation or preload failure leaves the exact live graph untouched. Runtime
failure starts compensating rollback. If rollback also fails, both errors are
retained in an `AggregateError`.

## Boundary

This spike models import with an async `load()` function and HMR identity with
an explicit revision string. It does not watch files, parse YAML, invalidate
Node's ESM cache, migrate component state, or preserve arbitrary state from an
activation that already drained.

Configuration transactions are serialized. Component setup and cleanup still
use Spike 004's in-flight transition runtime, and service dependencies—not
manifest position—determine activation order.

## Method

Build a declarative host over the unmodified Spike 004 runtime. Deterministic
loaders simulate success, syntax/import errors, and activation failure. Tests
compare handle, fiber, provider, and effect identity across rereads and rollback.

## Acceptance criteria

- Initial insertion follows service dependencies regardless of manifest order.
- Identical IDs and revisions preserve handles, fibers, effects, and module values.
- Disabling a parent drains descendants first and preserves unrelated entries.
- Re-enabling a subtree reuses handles with fresh fibers.
- Successful provider reload restarts only its dependency subgraph.
- Reload inside one isolated realm leaves its sibling unchanged.
- Load failure performs no live mutation.
- Activation failure restores the previous provider and consumers.
- Duplicate IDs, missing parents, and parent cycles fail before mutation.
- Queued manifests converge on the newest submitted configuration.
- Rollback failure preserves both the change and recovery errors.

## Result

Implemented `DeclarativeHost` over Spike 004. A no-op reread performed no new
load, activation, cleanup, or fiber replacement. Disabling a parent drained its
child before the parent while an unrelated fiber retained identity. Re-enabling
reused the same handles with fresh fibers.

Updating database V1 to V2 reactivated its repository but preserved an
unrelated component. Updating a provider in one isolated realm left the sibling
realm unchanged. A simulated syntax error failed during preload and retained
the exact previous provider fiber and effect.

Activation failure produced this compensating recovery trace:

```text
database-v1:activate
repository:v1:activate
repository:v1:dispose
database-v1:dispose
database-v2:activate
database-v2:rollback
database-v1:activate
repository:v1:activate
```

The V2 error was reported only after the V1 service graph worked again.

Commands run with Node `26.7.0`, npm `11.19.0`, TypeScript `7.0.2`, and
`@types/node` `26.2.0`:

```sh
npm install
npm run typecheck
npm test
node --test --experimental-test-coverage test/*.test.ts
```

Observed result:

- 9 tests passed; 0 failed, skipped, or cancelled.
- TypeScript completed with no errors.
- Native coverage reported 95.56% lines, 89.89% branches, and 93.33% functions
  for `src/host.ts`.
- Failed preload preserved the exact old fiber; failed activation restored the
  last working service graph through compensating activation.
- Queued manifests ended at the newest submitted revision.
- A deliberately failing restoration retained both the candidate activation
  error and the rollback activation error.

## Decision

The stable-ID, explicit-revision, preload-before-mutation, and compensating
rollback model is sufficient for this experiment. Proceed to Spike 006 for the
minimal harness slice.

Do not promote this loader as production HMR yet. Real file watching, ESM cache
invalidation, configuration parsing, schema migration, and crash-safe state
remain outside this spike.
