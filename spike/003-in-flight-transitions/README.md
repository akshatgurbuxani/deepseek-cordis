# Spike 003: In-flight transitions

## Question

What is the smallest lifecycle mechanism that lets dependency mutations arrive
while component setup or cleanup is still running, without publishing stale
services, tearing down a provider before its consumers drain, or leaving fibers
in a state that no longer matches the latest dependency graph?

## Why this follows Spike 002

Spike 002 proved dependency-safe activation and teardown while `add`, `remove`,
and `replace` operations are serialized. Its mutation queue deliberately waits
for all setup, cleanup, and reconciliation work from one operation before it
accepts the next operation.

Real runtimes cannot assume that lifecycle work finishes before the world
changes again. A provider may be removed while its setup is awaiting I/O, a
replacement may arrive while consumers are draining, or several replacements
may arrive before the first activation settles. The runtime must remember the
latest desired graph while allowing work already in flight to reach a safe
boundary.

## Primary sources

- Paper commit [`948a07b`](https://github.com/cordiverse/paper/commit/948a07b369c62adb3b12e102458be5c18dfb69b9),
  especially Section 4 on fibers, lifecycle transitions, inertia, and recovery.
- Upstream Cordis commit [`8cc9e33`](https://github.com/cordiverse/cordis/commit/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4),
  especially [`fiber.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/fiber.ts#L348-L458)
  for fiber state and transition scheduling, and
  [`reflect.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/reflect.ts#L175-L225)
  for dependency publication and draining.
- DeepSeek Harness commit [`b150a55`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e),
  especially vendored
  [`fiber.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/fiber.ts#L574-L696)
  for transition inertia and convergence, plus its earlier setup barriers and
  cleanup joining around `ctx.effect`.
- DeepSeek's
  [lifecycle and effects tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/cordis-tutorial/02-lifecycle-and-effects.md)
  for observable activation and disposal behavior.

## Hypothesis

A desired revision per fiber, one memoized transition promise per fiber, and a
reconciliation scheduler are enough to extend Spike 002 without cancelling
arbitrary component code.

Each dependency mutation updates desired state immediately and schedules
reconciliation. A transition already in flight is allowed to reach its next
safe boundary. Before activation publishes services, it checks that the
provider snapshot and desired revision are still current. If they are stale,
the activation disposes its fresh `EffectStack` without publishing anything.
When a transition settles, the scheduler compares actual state with the newest
desired state and continues until they agree.

This should preserve Spike 002's drain-before-recovery ordering while replacing
its global mutation queue with per-fiber transition joining and eventual
convergence.

## Proposed vocabulary and API

Keep Spike 002's service keys, components, committed provider views, and
activation-owned effect stacks, then add only these concepts:

- `desiredRevision`: the latest dependency target a fiber has been asked to
  follow.
- `committedRevision`: the target represented by its current active state.
- `transition`: the setup or cleanup promise currently owned by a fiber.
- `target`: whether the latest graph says the fiber should be active, pending,
  or disposed, including the provider identities required for activation.
- `settle()`: a test and caller-facing barrier that resolves when scheduled
  reconciliation has reached a fixed point for all mutations observed before
  the call.

The intended test usage should resemble:

```ts
const first = runtime.add(databaseV1)
await databaseV1Started.promise

const replacement = runtime.replace(first, databaseV2)
databaseV1MayFinish.resolve()

await runtime.settle()

assert.equal(replacement.state, 'active')
assert.equal(repository.context.get(database), databaseV2Value)
```

Mutation methods should record the new desired graph without waiting for every
resulting lifecycle transition. Tests will use explicit gates and `settle()` to
observe intermediate and converged states deterministically.

## State model

The experiment should distinguish desired state from actual state:

```text
dependency mutation
  -> update desired graph and revision
  -> schedule affected fibers
  -> join any transition already in flight
  -> recompute the newest target
  -> activate or deactivate toward that target
  -> verify the revision at the publication boundary
  -> repeat until actual state matches desired state
```

An activation has three important boundaries:

1. Snapshot the provider identities and allocate a fresh effect stack.
2. Let component setup finish without pretending arbitrary user code can be
   cancelled.
3. Publish only if the snapshot is still current; otherwise roll the activation
   back and reconcile toward the newest target.

A deactivation also has three important boundaries:

1. Withdraw services from new resolution.
2. Drain direct and transitive consumers while their committed views remain
   readable.
3. Recover the provider's own effects, then re-evaluate whether a newer target
   requires a fresh activation.

## Boundary

This spike permits `add`, `remove`, and `replace` mutations while setup or
cleanup promises are unresolved. Component code remains cooperative but is not
required to support cancellation. The runtime coordinates around arbitrary
promises rather than terminating them.

The experiment remains single-threaded and in-memory. It excludes cycles,
optional dependencies, multiple competing providers, isolation, interception,
configuration loading, HMR, and process-level failure. It does not promise to
undo irreversible external actions. It also does not allow two activations of
the same fiber to run concurrently; a fiber's current transition is its
serialization boundary.

## Method

Build a separate educational runtime using the ownership behavior from Spike
001 and the dependency graph behavior from Spike 002. Replace the global
mutation queue with explicit desired revisions, per-fiber transition promises,
and a scheduler that can be notified while it is already reconciling.

Use manually controlled promises for every race. Each test should pause setup
or cleanup at a named boundary, apply another dependency mutation, assert what
is and is not published at that moment, release the gate, call `settle()`, and
assert the final trace. Avoid timing-based sleeps so failures remain
deterministic.

## Acceptance criteria

- Removing a provider while its setup is in flight prevents that stale setup
  from publishing, then recovers every effect it acquired.
- Replacing a provider while its setup is in flight activates only the newest
  provider and never activates consumers against the stale identity.
- Removing a required provider while consumer setup is in flight causes the
  consumer's completed setup to roll back instead of becoming active.
- Re-adding a provider while a consumer is deactivating lets cleanup finish
  against the old committed view before a fresh activation begins.
- A provider is not recovered until all direct and transitive consumers have
  completed deactivation, even when a newer replacement is already waiting.
- Rapid add/remove/replace sequences converge to the graph implied by the last
  mutation, with no published service from an obsolete revision.
- An unrelated dependency subgraph continues transitioning independently and
  is not restarted by mutations elsewhere.
- Repeated notifications join existing setup or disposal promises and do not
  acquire or recover any effect twice.
- Setup and cleanup failures remain observable, release every owned resource
  they can, and do not strand a fiber in an unexplained transitional state.
- `settle()` does not resolve while reconciliation work caused by an observed
  mutation can still change fiber state or service publication.

## Suggested implementation order

1. Copy the smallest service-key, component, fiber, context, and committed-view
   model from Spike 002 while preserving the Spike 001 effect boundary.
2. Separate mutation acceptance from lifecycle settlement and introduce a
   monotonic runtime revision.
3. Give each fiber a desired target and one memoized transition promise.
4. Add a scheduler that coalesces notifications received during reconciliation
   and exposes a reliable `settle()` barrier.
5. Guard service publication with both desired revision and provider-identity
   checks; roll back stale activations.
6. Preserve leaf-first dependent draining while allowing replacement targets to
   wait behind old cleanup.
7. Add deterministic gated tests for setup races, cleanup races, rapid
   replacement, failure, unrelated subgraphs, and repeated notifications.
8. Record exact traces, coverage, deviations, and the resulting lifecycle state
   model before deciding whether to proceed to context isolation.

## Result

Implemented a desired-state runtime around Spike 001's `EffectStack` and Spike
002's service keys, fibers, committed provider views, and dependency-aware
draining. Mutations now update the desired graph synchronously. A notification
scheduler starts possible work without waiting for unrelated transitions, each
fiber memoizes at most one setup or cleanup promise, and `settle()` joins both
scheduled and in-flight work until the graph reaches a fixed point.

Activation snapshots both a desired revision and exact provider bindings.
Successful setup publishes only when both are still current. The provider-setup
replacement test produced this trace:

```text
database-v1:acquire
database-v1:recover
database-v2:activate
repository:v2
```

The repository never activated against V1. A rapid V1 -> V2 -> V3 sequence also
skipped V2 entirely and activated the repository once against V3.

The first consumer-setup race exposed an important drain bug: provider cleanup
waited for active consumers but initially overlooked a consumer whose setup was
still in flight. The failing trace placed database disposal before repository
rollback. Extending dependent draining to join `activating`, `active`, and
`disposing` consumers corrected the trace to:

```text
repository:acquire
repository:rollback
database:dispose
```

The replacement-during-cleanup test retained database V1 in the repository's
committed view until repository cleanup ended, then disposed V1, activated V2,
and created a fresh repository activation. A separate three-level test drained
API, repository, and database strictly from leaf to root. An unrelated
component activated while another setup remained blocked, demonstrating that
the scheduler accepts and progresses independent work instead of recreating a
global lifecycle queue.

Commands run with Node `26.7.0`, npm `11.19.0`, TypeScript `7.0.2`, and
`@types/node` `26.2.0`:

```sh
npm install
npm run typecheck
npm test
node --test --experimental-test-coverage test/*.test.ts
```

Observed result:

- 11 tests passed; 0 failed, skipped, or cancelled.
- TypeScript completed with no errors.
- Native coverage reported 90.51% lines, 87.04% branches, and 93.10% functions
  for `src/runtime.ts`.
- Stale provider and consumer setup recovered all acquired effects without
  publishing obsolete services.
- Repeated removal and concurrent settlement joined one cleanup transition.
- Activation and cleanup failures remained observable, completed available
  recovery, and left fibers in stable states.
- `settle()` included mutations accepted while it was already waiting.

## Decision

The desired-revision, provider-snapshot, per-fiber transition, notification
scheduler, and settlement-barrier model is sufficient to preserve dependency
safety under in-flight mutation. Keep stale-publication guards, synchronous
withdrawal cascades, transition joining, retiring-provider barriers, stable
failed-target suppression, and consumer-before-provider recovery.

Proceed to Spike 004 for context isolation and interception, but do not promote
this runtime into `harness/`. The experiment still excludes cycles, optional
and competing providers, cancellation, process failure, configuration/HMR, and
long-lived error observation policy. Those are separate design decisions rather
than evidence supplied by this spike.
