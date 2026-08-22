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

## Findings

The paper's unit is a component with three parts: required coeffects, provided keys, and an effectful application function. At runtime, each instance is represented by a fiber. The fiber owns a child context, a committed view of its resolved dependencies, a lifecycle state, any transition currently in flight, and the inverse operations needed for cleanup.

The mechanisms are coupled in a specific order:

1. Effects must be attributable to the context/fiber that created them.
2. A provider becoming unavailable must first stop satisfying dependencies.
3. Dependents must deactivate while the provider's bindings are still readable from their committed view.
4. Only after dependents drain may the provider recover its own effects.
5. A replacement provider causes affected consumers to activate against a new committed view.

That ordering is the heart of the architecture. A basic plugin registry with `load()` and `unload()` callbacks does not establish it.

## Experiment sequence

### 001: Effect stack

Implement only effect acquisition and inverse accumulation.

Acceptance criteria:

- Disposers run in reverse acquisition order.
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
