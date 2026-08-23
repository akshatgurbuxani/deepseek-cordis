# Spike 002: Dependency activation

## Question

What is the smallest runtime that activates a component only when all of its
declared services exist, and safely deactivates consumers before a required
provider is recovered?

## Why this follows Spike 001

Spike 001 proved that one owner can recover its effects. That is necessary but
not sufficient for plugins: disposing a database provider while a repository
plugin is still using it is unsafe even if both plugins have perfect cleanup
functions.

This spike adds the missing relationship between owners. A component declares
the service keys it requires and provides. The runtime derives activation and
deactivation order from those declarations rather than configuration order.

## Primary sources

- Paper commit [`948a07b`](https://github.com/cordiverse/paper/commit/948a07b369c62adb3b12e102458be5c18dfb69b9),
  Section 3 on reactive coeffects and Section 4 on components and committed
  dependency views.
- Upstream Cordis commit [`8cc9e33`](https://github.com/cordiverse/cordis/commit/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4),
  especially [`registry.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/registry.ts)
  and [`reflect.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/reflect.ts#L175-L225).
- DeepSeek Harness commit [`b150a55`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e),
  vendored [`registry.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/registry.ts)
  and [`reflect.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/reflect.ts).

## Hypothesis

A registry, a fiber per component, and a fresh `EffectStack` per activation are
enough to demonstrate reactive dependency coordination when runtime mutations
are serialized. Each active fiber retains the exact provider identities it
committed to, allowing its cleanup to read the old dependencies even after
those providers have been withdrawn from new resolution.

## Proposed vocabulary and API

The implementation should introduce only these concepts:

- `ServiceKey<T>`: a typed identity for one kind of service.
- `Component`: a name, required keys, provided key/value pairs, and `setup`.
- `Fiber`: one registered component, its state, committed providers, and its
  current activation's `EffectStack`.
- `Runtime`: registers/removes components and reconciles fibers until no more
  states can change.
- `Context.get(key)`: reads only from the fiber's committed dependency view.
- `Context.effect(setup)`: delegates ownership to the current activation scope.

The intended usage should resemble:

```ts
const database = service<Database>('database')

const repository = runtime.add({
  name: 'repository',
  requires: [database],
  setup(ctx) {
    const db = ctx.get(database)
    return ctx.effect(() => registerRepository(db))
  },
})

await runtime.add({
  name: 'database',
  provides: [[database, new SqliteDatabase()]],
  setup: () => undefined,
})
```

The precise return types may change during implementation, but the observable
semantics must not.

## Boundary

All `add`, `remove`, and `replace` operations are awaited and processed one at a
time. Setup and cleanup may be asynchronous, but no new dependency mutation is
introduced while one is running. Perturbing dependencies during an in-flight
transition is the question for Spike 003.

This spike also excludes optional dependencies, multiple competing providers,
cycles, isolation, interception, configuration loading, HMR, and agent-specific
services. Duplicate providers should fail explicitly rather than acquire an
unstated precedence rule.

## Method

Build an educational dependency runtime around the `EffectStack` from Spike
001. Reconciliation should follow dependency edges:

1. A fiber is eligible when every required key resolves to an active provider.
2. Activation snapshots those provider identities into a committed view.
3. Successful activation publishes the fiber's provided services.
4. Provider removal first withdraws its services from new resolutions.
5. Direct and transitive consumers deactivate from leaves toward the provider.
6. Consumer cleanup uses its old committed view.
7. Only after consumers drain may the provider recover its own effects.
8. Reconciliation activates newly eligible fibers from providers toward leaves.

## Acceptance criteria

- Registering a consumer before its provider leaves the consumer pending.
- Configuration order does not determine activation order.
- A consumer requiring multiple keys activates once, only after the final key
  becomes available.
- A failed provider setup publishes no service and leaves consumers pending.
- Removing a required provider deactivates direct and transitive consumers
  before provider cleanup begins.
- A deactivating consumer can still read the provider from its committed view.
- Removing one provider does not deactivate unrelated components.
- Adding a replacement provider reactivates consumers against the replacement
  identity, with a fresh activation-owned `EffectStack`.
- Duplicate providers for one key are rejected with a useful error.
- Repeated removal is idempotent and no activation effect is recovered twice.

## Suggested implementation order

1. Add typed service keys and type-erased internal maps.
2. Add fibers with `pending`, `active`, and `disposed` states.
3. Activate a pending fiber from a snapshot of resolved providers.
4. Publish provisions only after successful setup.
5. Implement dependency-aware draining and committed-view cleanup.
6. Add replacement and unrelated-subgraph tests.
7. Record traces and update the Result and Decision sections.

## Result

Implemented a small, dependency-free runtime around Spike 001's `EffectStack`.
Typed service keys are identity-bearing objects rather than strings. Each
registered component has a fiber whose state is `pending`, `active`, or
`disposed`; each successful activation owns a fresh effect stack and retains a
snapshot of the exact provider bindings it committed to.

Reconciliation reached a fixed point independent of registration order. A
consumer registered before its provider remained pending, and a two-service
consumer activated exactly once after its final requirement became available.
Setup failure recovered activation effects before surfacing the error and did
not publish the failed provider's services.

The provider-replacement test produced this trace:

```text
repository:v1:activate
repository:v1:dispose
database-v1:dispose
database-v2:activate
repository:v2:activate
```

A separate three-level test observed `api` cleanup before `repository`
cleanup, and observed the old database as still alive during repository
cleanup. Only after both consumers drained did database cleanup run. An
unrelated logger/metrics subgraph stayed active throughout. Replacement
validation also ran before teardown, so an invalid replacement did not disturb
the working provider.

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
- Native coverage reported 91.96% lines, 85.90% branches, and 96.67% functions
  for `src/runtime.ts`.
- Duplicate service declarations failed explicitly, repeated removal was
  idempotent, and a failed replacement preflight left the old provider active.

## Decision

The minimal registry/fiber/committed-view model is sufficient to preserve the
drain-before-recovery invariant while mutations are serialized. Keep typed
service identity, fixed-point activation, activation-local effect ownership,
committed provider views, leaf-first draining, preflighted replacement, and
explicit duplicate-provider rejection.

Proceed to Spike 003 to test mutations that arrive during asynchronous setup or
cleanup. Do not promote this runtime into `harness/`: it intentionally queues
mutations and therefore has not yet demonstrated transition convergence,
stale-activation prevention, cycle diagnostics, or competing-provider policy.
