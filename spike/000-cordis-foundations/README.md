# Spike 000: Cordis foundations

## Question

What is the smallest sequence of experiments that demonstrates the two properties Cordis claims for dynamic components: complete recovery of owned effects and reactive coordination of dependencies?

This is a research-design spike. It records the upstream model and turns it into executable follow-up work; it does not yet contain an implementation.

## Primary sources

- [Paper PDF](https://github.com/cordiverse/paper/blob/main/paper.pdf), draft dated August 13, 2026:
  - Section 3: revertible effects, reactive coeffects, and unified contexts.
  - Section 4: components, fibers, lifecycle transitions, and global composability.
  - Section 5: Cordis core, loader, HMR, and Koishi case study.
  - Section 6: system boundaries, access control, sandboxing, cycles, and dependency versioning.
- [Cordis repository](https://github.com/cordiverse/cordis) for the independent implementation.
- [DeepSeek Cordis tutorial](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/cordis-tutorial) for public API behavior.
- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) for the agent-level composition built on those primitives.

Record exact commit SHAs in each executable child spike. The upstream paper and APIs are under active revision.

Baseline inspected for this research spike:

- Paper: [`948a07b`](https://github.com/cordiverse/paper/commit/948a07b369c62adb3b12e102458be5c18dfb69b9)
- Cordis: [`8cc9e33`](https://github.com/cordiverse/cordis/commit/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4)
- DeepSeek Harness: [`b150a55`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e)

The upstream Cordis and DeepSeek-vendored Cordis source snapshots differ materially. Follow-up experiments must name which one supplies the expected behavior rather than referring to “Cordis” ambiguously.

## Hypothesis

The two composition claims can be tested without building a loader or agent harness first. An effect-only experiment, a dependency experiment, and an in-flight-transition experiment should be sufficient to expose the minimum ownership, ordering, and convergence rules. Isolation, declarative loading, HMR, and harness services can then be layered onto those proven rules.

## Boundary

This spike covers the semantics that a cooperative in-process component runtime can observe and coordinate: context-owned registrations, declared service requirements and provisions, fiber lifecycle, and author-supplied disposers. It does not claim to reverse an external network send or committed database write, validate behavioral compatibility between providers, or contain malicious host-language code.

## Method

This spike compares the paper's model with two pinned TypeScript implementations: independent upstream Cordis and the Cordis snapshot vendored by DeepSeek Harness. It extracts observable invariants and assigns each one to a narrow executable child spike. It intentionally implements no runtime code.

## Acceptance criteria

- Every foundational term has one project-local meaning and one observable consequence.
- The provider-replacement trace states the required dependency ordering.
- Each proposed mechanism points to pinned source and an executable child spike.
- Differences between upstream and DeepSeek-vendored Cordis become test questions rather than accidental implementation choices.
- The decision identifies the smallest next experiment and what evidence it must produce.

## Result

The paper's unit is a component with three parts: required coeffects, provided keys, and an effectful application function. At runtime, each instance is represented by a fiber. The fiber owns a child context, a committed view of its resolved dependencies, a lifecycle state, any transition currently in flight, and the inverse operations needed for cleanup.

The mechanisms are coupled in a specific order:

1. Effects must be attributable to the context/fiber that created them.
2. A provider becoming unavailable must first stop satisfying dependencies.
3. Dependents must deactivate while the provider's bindings are still readable from their committed view.
4. Only after dependents drain may the provider recover its own effects.
5. A replacement provider causes affected consumers to activate against a new committed view.

That ordering is the heart of the architecture. A basic plugin registry with `load()` and `unload()` callbacks does not establish it.

## Foundation model

The shortest useful explanation of Cordis is: **a context is an ownership boundary and a dependency view at the same time**.

- As an ownership boundary, it records everything a component must undo.
- As a dependency view, it exposes only the service implementations committed to that component's current activation.
- A fiber joins those responsibilities by deciding when the component may run and by retaining the disposer that returns its owned portion of the context to its prior state.

This gives the foundational vocabulary below. The paper terms describe the model; the runtime terms name one TypeScript implementation of that model.

| Term | Meaning in this project | Observable consequence |
| --- | --- | --- |
| Effect | A change made while applying a component | The change is attributed to the applying fiber. |
| Revertible effect | An effect paired with an author-supplied inverse | Unloading invokes the inverse at most once. |
| Coeffect | Something the component needs from its environment | The requirement participates in whether the component may activate. |
| Reactive coeffect | A requirement whose resolution is tracked over time | Provider changes cause the consumer to converge on a new lifecycle state. |
| Context | The combined effect owner, service view, and mediation surface | Calls made through `ctx` can be attributed, resolved, isolated, and intercepted. |
| Component | Requirements, provisions, and an effectful `apply` operation | It can be composed without importing a concrete provider. |
| Fiber | One live runtime instance of a component | Separate applications of the same component have separate state and cleanup. |
| Committed dependency view | The exact provider identities visible to one activation | A consumer tears down against the old view before it starts against a new one. |
| Inertia | The transition already in flight | A newer target waits for a safe boundary instead of cancelling teardown halfway through. |

### One complete trace

Assume a database component provides `database`, a repository component requires `database` and provides `repository`, and an API component requires `repository`. Replacing the database should produce this dependency-safe trace:

```text
mark old database unavailable for new resolutions
  -> unload API
  -> unload repository while its committed database view is still readable
  -> recover the old database effects
  -> activate the new database
  -> activate repository with the new database identity
  -> activate API with the new repository identity
```

This is not necessarily one globally serial execution. Independent cleanup may overlap. The required ordering is the dependency ordering: a provider must not recover the state a dependent still needs for its own teardown.

### Foundation invariants

The executable child spikes should make these statements precise:

1. **Ownership:** disposing one fiber reclaims its effects and descendants without reclaiming sibling effects.
2. **Single recovery:** every acquired reversible effect is recovered at most once, including explicit disposal followed by parent disposal.
3. **Dependency safety:** an active consumer only observes providers in its committed dependency view.
4. **Drain before recovery:** provider teardown waits for affected consumers to finish deactivating.
5. **Transition convergence:** after lifecycle work settles, each fiber reflects the newest dependency target rather than an obsolete intermediate target.
6. **Failure containment:** failed or partial activation leaves no completed acquisition without an owned recovery path.
7. **Honest boundary:** the runtime promises coordination of declared inverses, not reversal of arbitrary external history.

## Source-to-runtime map

The pinned source inspection produced these concrete anchors:

| Foundation concern | Upstream Cordis `4.0.0-rc.8` | DeepSeek-vendored Cordis `4.0.1` | Child spike |
| --- | --- | --- | --- |
| Context derivation, isolation, interception | [`context.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/context.ts) | [`context.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/context.ts) | 004 |
| Effect collection and disposal | [`fiber.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/fiber.ts#L275-L340) | [`fiber.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/fiber.ts#L415-L560) | 001 |
| Fiber state and transition inertia | [`fiber.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/fiber.ts#L348-L458) | [`fiber.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/fiber.ts#L574-L696) | 002–003 |
| Service provision and dependent draining | [`reflect.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/reflect.ts#L175-L225) | [`reflect.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/reflect.ts) | 002–003 |
| Component registration and declared injection | [`registry.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/registry.ts) | [`registry.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/registry.ts) | 002 |

The snapshots share the same broad architecture but differ in lifecycle edge-case handling. For example, the DeepSeek snapshot adds setup barriers, reentrant-disposal handling, and stronger cleanup joining around `ctx.effect`. Those differences are evidence for comparison tests; they are not details to silently copy into an educational implementation.

One teardown detail also needs an explicit experiment. A disposer group returned by a single `ctx.effect` is unwound sequentially in reverse order, while separate fiber-owned async effects are started in reverse registration order and awaited concurrently. “LIFO cleanup” therefore needs to specify whether it means start order, completion order, or strict serialization.

## Experiment sequence

### 001: Effect stack

Implement only effect acquisition and inverse accumulation.

Acceptance criteria:

- Synchronous disposers begin in reverse acquisition order.
- Multiple disposers collected by one effect unwind sequentially in reverse order.
- Separate async effects begin in reverse registration order but may overlap; the trace distinguishes start order from completion order.
- Repeated disposal has no additional effect.
- A partially completed asynchronous acquisition recovers only completed steps.
- Disposing a parent recursively disposes child effects without touching a sibling.
- A thrown activation cannot leave a registered timer, listener, or service behind.

### 002: Dependency activation

Add service keys, provisions, requirements, and pending consumers.

Acceptance criteria:

- Configuration order does not determine activation order.
- A consumer stays pending until every required key is provided.
- Adding the final provider activates the consumer once.
- Removing a required provider deactivates the consumer before provider cleanup.
- Adding a replacement provider reactivates the consumer against the replacement identity.

### 003: In-flight transitions

Make activation and disposal asynchronous, then perturb dependencies while each transition is running.

Acceptance criteria:

- A stale activation does not become active after its dependency target changes.
- The current transition reaches a safe boundary before the fiber follows the latest target.
- Rapid add/remove/replace sequences converge to the state implied by the final provider set.
- Failures are observable and do not strand a fiber in an unexplained intermediate state.

### 004: Context isolation and interception

Resolve one service key differently in two derived contexts and attach policy metadata to access.

Acceptance criteria:

- Replacing a provider in one isolated realm does not restart consumers in the other.
- Updating interception policy changes service use without changing dependency satisfaction.
- Undeclared access is rejected through the mediated context API.
- The experiment explicitly demonstrates that this is not a sandbox for malicious host-language code.

### 005: Declarative reconciliation and HMR

Represent the desired plugin tree as stable configuration entries and reconcile it with live fibers.

Acceptance criteria:

- Insert, remove, disable, and replacement affect only the relevant subtree and dependents.
- Entry identity is stable across configuration rereads.
- A successful reload preserves unrelated state.
- A syntax/import/activation failure restores the last working composition.

### 006: Minimal harness slice

Compose an append-only session log, one model adapter, one tool registry, and one agent loop as plugins.

Acceptance criteria:

- The run records model-visible input, output, tool calls, and tool results as durable events.
- Model and tool providers can be replaced by configuration.
- Removing a provider withdraws its registrations and coordinates dependent loop state.
- A deterministic adapter can replay the same recorded scenario in tests.

## Risks to carry forward

- The runtime cannot verify that an author-provided inverse truly restores the prior state.
- Network sends and shared persistent writes cross the recovery boundary unless wrapped in transactions, withholding, or compensation.
- Service names alone do not prove interface or behavioral compatibility across independently versioned plugins.
- Cyclic required dependencies can leave all participants inactive; diagnostics are part of the minimum viable runtime.
- Context-mediated authority is useful for cooperative plugins, but hostile plugins require process, VM, WebAssembly, or container isolation.
- The paper's Koishi evidence is an existence/adoption case study, not a controlled performance or productivity comparison.

## Decision

Proceed with experiments 001 through 003 before choosing whether `harness/` should depend on Cordis or contain an educational reimplementation. Those experiments cover the core temporal and spatial claims and will expose the consequences of that choice with much less sunk cost than beginning from an agent UI or model integration.
