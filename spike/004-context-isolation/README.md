# Spike 004: Context isolation and interception

## Question

What is the smallest context model that lets the same service key resolve to
different providers in separate component realms, while independently changing
how a resolved service is used without changing which provider satisfies the
dependency?

## Why this follows Spike 003

Spikes 001 through 003 established ownership, dependency ordering, and
convergence under overlapping lifecycle transitions. Their service registry is
still global: one `ServiceKey` has one provider for the entire runtime.

A harness needs narrower composition boundaries. Two agents may use different
model or storage providers, and one agent may attach logging, quotas, or access
checks without restarting every consumer or changing provider identity. This
spike makes service resolution spatially scoped while preserving the lifecycle
ordering already demonstrated.

## Primary sources

- Paper commit [`948a07b`](https://github.com/cordiverse/paper/commit/948a07b369c62adb3b12e102458be5c18dfb69b9),
  Section 3 on unified contexts, Section 4 on committed coeffects, and Section
  6 on access control and sandbox boundaries.
- Upstream Cordis commit [`8cc9e33`](https://github.com/cordiverse/cordis/commit/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4),
  especially [`context.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/context.ts)
  for derived contexts, isolation, and interception.
- DeepSeek Harness commit [`b150a55`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e),
  especially vendored [`context.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/context.ts)
  and the harness `scope` package as an application-level consumer of scoped
  registration.

## Hypothesis

A tree of realms plus a two-stage service lookup is sufficient:

1. **Resolution** selects a provider binding from the consumer's realm and
   isolation rules. That binding participates in dependency satisfaction,
   committed views, stale-target checks, and lifecycle draining.
2. **Interception** transforms access to the already committed value. It may
   add policy or instrumentation, but it does not change provider identity or
   dependency satisfaction.

Keeping these stages separate should allow policy changes without component
reactivation and provider replacement in one isolated realm without disturbing
another realm.

## Proposed vocabulary and API

Extend the Spike 003 runtime with:

- `Realm`: a node with a parent, isolated service keys, and interceptors.
- `runtime.root`: the default realm.
- `realm.derive(options)`: creates a child realm.
- `Component.realm`: selects where a component provides and resolves services.
- `ProviderSlot`: the identity produced by `(resolution realm, service key)`.
- `Interceptor<T>`: transforms or guards a committed service value at access
  time using requester metadata.

The intended usage should resemble:

```ts
const model = service<Model>('model')
const agentA = runtime.root.derive({ isolate: [model] })
const agentB = runtime.root.derive({ isolate: [model] })

runtime.add({
  name: 'model-a',
  realm: agentA,
  provides: [[model, modelA]],
  setup() {},
})

runtime.add({
  name: 'consumer-a',
  realm: agentA,
  requires: [model],
  setup(ctx) {
    ctx.get(model) // modelA
  },
})

agentA.intercept(model, ({ value, consumer }) =>
  withUsageLimit(value, consumer.name),
)
```

The exact surface may change during implementation. Tests must describe
resolution, provider identity, and access transformation separately.

## Resolution model to test

For a required key, lookup starts in the consumer's realm and walks toward the
root. An isolation declaration introduces a slot boundary:

- Providers inside that isolated subtree may satisfy consumers in the same
  subtree.
- A provider above the boundary does not satisfy the isolated key below it.
- Separate isolated subtrees may each provide the same service key.
- Keys that are not isolated continue to inherit through the realm ancestry.

Duplicate-provider rejection applies per effective provider slot, not globally.
Two isolated realms may provide `model`; two providers competing for `model`
inside one realm remain an explicit error.

## Interception model to test

`Context.get(key)` first verifies that the component declared and committed the
key. It then applies the current interceptor chain associated with the
consumer's realm. Interceptors receive the requesting fiber, key, committed
provider identity, and value.

Changing an interceptor must not alter the committed provider binding or make
an unsatisfied dependency appear satisfied. The experiment should choose and
document deterministic ancestor/descendant interceptor order. A disposer must
remove an interceptor without affecting the provider registration.

## Boundary

This remains a cooperative, in-process TypeScript runtime. Mediated access can
deny `ctx.get()` or wrap a returned capability, but plugin code can bypass it
through direct imports, globals, filesystem calls, or network APIs. Isolation
is a composition namespace and interception is a policy hook; neither is a
sandbox for hostile code.

The spike excludes cycles, optional dependencies, competing providers within
one slot, configuration loading, HMR, process isolation, and agent-specific
policy design. It should retain Spike 003's in-flight mutation and settlement
behavior rather than reverting to a global mutation queue.

## Method

Adapt the Spike 003 runtime so published bindings are indexed by provider slot
instead of service key alone. Snapshot committed bindings after realm-aware
resolution, and continue using their exact identities for stale-publication
guards and dependent draining. Apply interceptors only when a committed value
is accessed.

Use two sibling realms plus the root in deterministic tests. Trace activation,
access, replacement, cleanup, and interceptor calls. Include the existing
provider-replacement race as a regression test so spatial scoping cannot weaken
temporal convergence.

## Acceptance criteria

- Two isolated sibling realms can publish different providers for the same
  service key and activate consumers against their local identities.
- A duplicate provider in one effective slot is rejected, while the same key
  in another isolated slot is accepted.
- Replacing a provider in realm A drains and reactivates only realm A's
  consumers; realm B remains active with the same committed identity.
- A non-isolated key falls back to the nearest available ancestor provider.
- An isolated key remains unsatisfied below its boundary when only an ancestor
  provider exists.
- Parent and child interceptor order is deterministic and covered by a trace.
- Adding, updating, or removing an interceptor changes subsequent service use
  without restarting the consumer or changing its committed provider.
- An interceptor can reject access with requester-aware diagnostics without
  making the dependency unsatisfied.
- `Context.get()` rejects access to a key the component did not declare.
- Removing a realm-owned interceptor or component recovers its registrations
  once without affecting sibling realms.
- Provider replacement during in-flight setup still rejects stale publication
  within the affected realm.
- The result explicitly demonstrates a direct host-language access that the
  context cannot mediate, preserving the honest sandbox boundary.

## Suggested implementation order

1. Add realm identity, parentage, and component placement without isolation.
2. Replace the global key map with effective provider slots.
3. Add isolation boundaries and sibling-local provider tests.
4. Make dependency snapshots and draining realm-aware.
5. Add dynamic interceptor chains after provider resolution.
6. Add declared-access enforcement and requester metadata.
7. Re-run an in-flight replacement scenario inside one isolated realm.
8. Record traces, coverage, limitations, and the promotion decision.

## Result

Pending implementation.

## Decision

Pending evidence. Do not begin declarative loading or HMR until isolated
provider replacement and policy updates preserve the ownership and convergence
invariants from Spikes 001 through 003.
