# deepseek-cordis

Research and implementation workspace for understanding how [Cordis](https://github.com/cordiverse/cordis) makes dynamically loaded software *spatiotemporally composable*, and how [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) applies that model to an agent harness where every capability is a plugin.

> [!IMPORTANT]
> This project is about **Cordis**, the plugin meta-framework. It is not about the numerical CORDIC algorithm for trigonometric functions.

## Use the coding harness

Node 24 or newer can build and install the CLI as one self-contained package:

```sh
npm install
npm pack
npm install --global ./deepseek-cordis-0.1.0.tgz
deepseek-cordis --init
```

Set `OPENROUTER_API_KEY`, then run
`deepseek-cordis --profile ./deepseek-cordis.json "your coding task"`. See the
[`CLI guide`](harness/cli/README.md) for interactive use, Docker isolation,
session discovery and resume, provider routing, and operational limits.

This repository started from first principles: study the formal model, reproduce its smallest runtime mechanisms in isolated spikes, and only then promote proven behavior into a maintained `harness/` implementation. Spikes 000–007 completed that evaluation and selected a pinned upstream Cordis runtime. The production packages under [`harness/`](harness/README.md) now include a deterministic or OpenRouter-backed text CLI that streams completed text, supports cooperative turn cancellation, and can persist, repair, resume, and provenance-preservingly compact its cross-process-coordinated immutable event history. A versioned request-pressure meter and bounded context-budget policy invoke that compaction automatically before provider limits or after a canonical overflow. OpenRouter capacity can be resolved from its model catalog; successful provider usage anchors later pressure estimates without pretending heuristic deltas are exact; and completion requests use explicit routing plus bounded, cancellable pre-stream retries. Consequential tools are separated from harmless local handlers by fail-closed one-shot approval, provider-owned sandbox execution, durable audit events, and Cordis-replaceable safety capabilities. A multi-turn control plane dispatches inspect, compaction, help, and exit commands outside model context while recording crash-repairable command boundaries; the active interaction channel owns approval prompting and displays exact arguments. Workspace providers offer bounded, observation-guarded file operations and approved structured-argv command execution through explicit local/partial or Docker/full backends. Versioned immutable profiles select the deployment's model, persistence, workspace, visible tools, process budgets, prompt sections, approval default, and context policy before the Cordis graph mounts. The goal is not to clone DeepSeek Harness feature-for-feature; it is to build the smallest durable, composable harness whose behavior we can explain and test.

## Primary sources

The plan is grounded in these upstream sources:

- [A Programming Paradigm for Spatiotemporal Composability (PDF)](https://github.com/cordiverse/paper/blob/main/paper.pdf), by Yifan Shi, Wei Zhang, and Tianyi Cui. The current August 13, 2026 draft is an actively revised preprint, so conclusions tied to theorem or section numbers must be checked against the latest revision.
- [Paper repository and abstract](https://github.com/cordiverse/paper), including the authors' warning that the preprint may change substantially.
- [Cordis source code](https://github.com/cordiverse/cordis), the TypeScript implementation of the paper's context, effect, coeffect, component, and loader model.
- [Cordis primer](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer) and [official Cordis tutorial](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/cordis-tutorial), which connect the formal terminology to the public runtime API.
- [DeepSeek Harness source](https://github.com/deepseek-ai/deepseek-harness) and [architecture guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md), which show how models, tools, sessions, storage, sandboxes, loops, scheduling, and UI are composed as Cordis plugins.
- [DeepSeek Harness developer preview](https://www.deepseek.com/harness/en/), the upstream product statement for “Everything is a plugin” and append-only, inspectable agent trajectories.
- [Koishi source](https://github.com/koishijs/koishi), the production ecosystem used as the paper's case study. The paper reports more than 4,000 community plugins, while noting that Koishi currently uses Cordis v3 and the paper describes Cordis v4.

Upstream Cordis and DeepSeek Harness both state that their APIs are unstable. We should pin exact commits in executable spikes instead of relying on floating branches or package versions.

### Research baseline

This plan was checked on August 21, 2026 against:

- Paper commit [`948a07b`](https://github.com/cordiverse/paper/commit/948a07b369c62adb3b12e102458be5c18dfb69b9), containing the August 13 draft.
- Upstream Cordis commit [`8cc9e33`](https://github.com/cordiverse/cordis/commit/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4).
- DeepSeek Harness commit [`b150a55`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e), release `dsh-0.1.1-rc.2`, whose vendored package identifies itself as `@deepseek-ai/cordis` version `4.0.1`.

DeepSeek's vendored Cordis snapshot is materially different from the current `cordiverse/cordis` tree, so this project must treat them as separate comparison targets. The first implementation entry points inspected were upstream [`packages/core/src/context.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/context.ts) and [`fiber.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/fiber.ts), versus DeepSeek's vendored [`context.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/context.ts) and [`fiber.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/fiber.ts). Agent-level reference points include the pinned [`session`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session), [`tools`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools), and [`agent-loop`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop) packages.

## What the paper proposes

Dynamic composition has two independent failure modes:

1. **Temporal composability:** removing a component must reverse the effects that component introduced without restarting the whole process or disturbing unrelated state.
2. **Spatial composability:** components must declare what they require and provide; the runtime must react when providers appear, disappear, or are replaced.

The paper lifts classical effects and coeffects into runtime mechanisms:

- A **revertible effect** performs a context transformation and returns its inverse. The runtime accumulates inverses and runs them in reverse order during disposal.
- A **reactive coeffect** describes a dependency on the context. Changes to available dependencies cause affected components to activate, deactivate, or remain unchanged.
- A unified **context** carries both the mutable environment and dependency resolution state.
- A **component** combines requirements, provisions, and an effectful `apply` operation.
- A **fiber** is one runtime instance of a component, including its parent, committed dependencies, lifecycle state, and accumulated disposer.

Cordis implements this in three tiers described by Section 5 of the paper:

| Paper tier | Runtime responsibility | Representative Cordis/Harness concepts |
| --- | --- | --- |
| Core library | Track effects, resolve coeffects, and coordinate component lifecycles | `Context`, `ctx.effect`, `ctx.get`/`ctx.set`, `inject`, fibers, isolation, interception |
| Component loader | Reconcile a declarative plugin tree and reload changed modules | configuration entries, stable IDs, groups, incremental reconciliation, HMR rollback |
| Application framework | Add domain vocabulary without changing composition semantics | Koishi plugins; DeepSeek model, tool, session, agent-loop, storage, sandbox, and UI plugins |

The central engineering claim we need to test is stronger than “plugins can be loaded.” A provider must be replaceable while the process stays alive, its dependents must deactivate before the provider is torn down, all owned effects must be reclaimed, and the dependents must reactivate against the new provider.

## Paper-to-code map

Our initial implementation target follows the paper's algorithms rather than the full DeepSeek product surface:

| Paper concept | Cordis operation | Behavior to reproduce and test |
| --- | --- | --- |
| Revertible effect | `ctx.effect(callback)` | Acquire a resource, record its inverse, and dispose at most once in LIFO order |
| Reactive coeffect | `ctx.set`, `ctx.get`, `inject` | Keep consumers inactive until requirements exist and refresh them when bindings change |
| Component instance | fiber / `ctx.plugin` or `ctx.use` | Track parentage, committed dependency view, state, transition in flight, and disposer |
| Lifecycle | pending/loading/active/unloading/disposed or failed states | Complete an in-flight transition, then converge on the newest dependency target |
| Provision withdrawal | provider notification and dependent draining | Mark a provider unavailable, unload dependents, then recover provider effects |
| Derived context | child context | Attribute registrations and cleanup to the component that created them |
| Isolation | `ctx.isolate` | Allow the same service key to resolve to different providers in separate realms |
| Interception | `ctx.intercept` | Change how a service is used without changing which provider satisfies it |
| Declarative composition | `cordis.yml` entries | Reconcile plugin entries by stable identity rather than restart the application |
| HMR | Cordis HMR plugin | Replace stale modules transactionally and restore the previous modules on failure |

The paper makes important boundary conditions explicit. Inverses are supplied by component authors and are not proven correct by the runtime. External emissions such as network sends or irreversible writes cannot generally be undone; they require withholding, transactions, or compensating actions. Cordis dependency declarations provide capability-like mediation, but untrusted plugin code still requires an external sandbox. Dependency key versioning and structural compatibility remain open problems.

## Relationship to DeepSeek Harness

[DeepSeek's architecture guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) describes a running harness as a Cordis plugin tree assembled from ordered configuration layers. There is no privileged agent core that every extension must patch. Plugins contribute typed events, reversible registrations, and services to a shared context.

The first Harness domains worth studying are:

- `session`: append-only durable events used to resume, fork, search, replay, and reconstruct what the model saw.
- `system-prompt`: scoped registration and assembly of prompt sections and tool schemas.
- `tools`: a scoped tool registry and guarded execution pipeline.
- `llm`: model message/stream vocabulary and replaceable adapters.
- `agent` and `agent-loop`: the live agent interface and default turn/step driver.
- `scope`: per-agent scoped registrations.

These are later consumers of the Cordis foundation, not the first implementation milestone. A minimal harness should be composed from them only after component unloading and dependency replacement are demonstrated independently.

## Repository layout

```text
.
├── README.md
├── harness/
│   ├── README.md
│   ├── protocol/
│   ├── session/
│   ├── model/
│   ├── approval/
│   ├── sandbox/
│   ├── sandbox-workspace/
│   ├── configuration/
│   ├── commands/
│   ├── command-session/
│   ├── tools/
│   ├── agent-loop/
│   ├── runtime-cordis/
│   ├── app-boot/
│   ├── model-openrouter/
│   ├── process/
│   ├── process-workspace/
│   ├── session-file/
│   ├── compaction/
│   ├── token-meter/
│   ├── context-budget/
│   └── cli/
└── spike/
    ├── README.md
    └── 000–007/
```

Directories are created only when their first accepted artifact exists:

- `spike/`: disposable experiments, source notes, and measurements. Spikes may depend directly on upstream Cordis or implement a mechanism from scratch.
- `harness/`: maintained production packages promoted from proven behavior.
  Capability contracts remain independent of Cordis; `runtime-cordis` alone
  owns production runtime integration.
- `docs/`: durable architecture decisions and paper notes that apply across implementations.
- `examples/`: runnable compositions demonstrating provider swaps, failure recovery, and eventually a minimal agent.

## Research and implementation plan

### 0. Establish the baseline

- Pin the paper, Cordis, and DeepSeek Harness revisions used for each experiment.
- Build a terminology map from paper definitions to Cordis v4 APIs and DeepSeek's vendored/runtime usage.
- Record where DeepSeek differs from upstream Cordis instead of assuming they are identical.

Exit condition: every planned primitive names its paper section, upstream implementation reference, and observable acceptance test.

### 1. Reproduce revertible effects

- Implement the smallest context that accepts an effect callback and accumulates disposers.
- Verify reverse-order cleanup, idempotent disposal, asynchronous cleanup, partial initialization failure, nested component cleanup, and ownership attribution.
- Demonstrate the system boundary with one reversible resource and one intentionally irreversible emission.

Exit condition: disposing a component restores all state inside the declared test boundary without touching sibling component state.

### 2. Reproduce reactive dependencies

- Model service keys, providers, consumer requirements, and a committed dependency view.
- Keep a consumer pending while a required service is absent.
- Activate it when the provider appears, unload it before the provider disappears, and reactivate it when a replacement appears.
- Test provider replacement during asynchronous activation and teardown.

Exit condition: randomized provider/consumer operation sequences converge without a consumer observing a withdrawn dependency.

### 3. Build the component lifecycle

- Combine requirements, provisions, effects, parent-child contexts, and fiber state.
- Implement transition inertia: an activation or deactivation completes safely before following the latest target state.
- Detect and report unsatisfied dependencies and dependency cycles rather than leaving unexplained pending fibers.
- Add isolation and interception only after the base lifecycle is stable.

Exit condition: lifecycle traces satisfy explicit invariants for cleanup, dependency ordering, progress, and final-state convergence.

### 4. Add declarative composition

- Define a small, versioned configuration schema with stable entry IDs.
- Reconcile insert, remove, disable, config change, and provider replacement incrementally.
- Prototype transactional HMR: identify affected entries, dispose them, import replacements, and restore the previous working set if import or activation fails.

Exit condition: a failed reload leaves the previous composition operational, while a successful reload preserves unrelated in-memory state.

### 5. Assemble the minimal harness

- Add an append-only session event stream first; derive views rather than mutating hidden session state.
- Define model, prompt, tool registry, tool execution, and agent-loop contracts as services/plugins.
- Run a text-only agent with one model adapter and one tool through the same component runtime.
- Capture every model-visible input, tool call/result, and lifecycle/configuration change needed for replay.

Exit condition: model and tool implementations can be swapped through composition, a recorded run can be inspected/replayed, and unloading either plugin leaves no live registrations.

### 6. Evaluate the architecture

- Compare our behavior with pinned Cordis and DeepSeek Harness scenarios.
- Measure activation, provider replacement, and teardown overhead.
- Threat-model plugin access, irreversible effects, dependency compatibility, configuration trust, and sandbox boundaries.
- Decide whether the project should remain an educational reimplementation, become a Cordis-based harness, or contribute focused plugins upstream.

## Pull request strategy

Work is developed as a stack of reviewable branches:

1. `docs/initial-repository-plan` defines the researched scope and spike protocol.
2. Each spike branches from the latest accepted planning branch and contains one question plus its evidence.
3. Promotion PRs branch from the relevant accepted spike and move only proven behavior into `harness/`.
4. Dependent PRs remain explicitly stacked until their base merges; PR descriptions state the base branch and review order.

No implementation is promoted because it resembles upstream code. Promotion requires a stated invariant, an executable test, and a decision about whether we are reimplementing, adapting, or directly depending on Cordis.

## Current decisions and open questions

Decided:

- Use the paper and official repositories as primary sources.
- Treat Cordis composition semantics as the foundation and DeepSeek Harness as the principal agent-harness case study.
- Learn through isolated executable spikes before creating `harness/`.
- Preserve source provenance and licenses; do not copy upstream implementation into experiments without documenting it.
- Use TypeScript and ESM for production packages.
- Pin upstream `cordis@4.0.0-rc.8` behind a dedicated adapter rather than promoting the educational runtime or initially vendoring Cordis.
- Use a domain-neutral text/tool loop as the first production agent scenario.
- Keep immutable session events as the only source of model-visible history.
- Use validated immutable profiles and explicit transactional reload rather
  than importing DeepSeek Harness's complete bundle/configuration layer.
- Keep local command execution explicitly partial and use an opt-in,
  fail-closed Docker backend for full confinement within a documented Docker
  trust boundary.
- Treat plugin code as trusted composition code. Consequential model actions
  cross the `sandbox` provider boundary; the host has no local handler for
  those definitions and claims no isolation when a real provider is absent.

Still open:

- Whether measured long-session behavior justifies replacing bounded
  whole-document JSON persistence with an incremental store.

The maintained near-term sequence lives in [`docs/roadmap.md`](docs/roadmap.md).
Historical feature outcomes remain in [`harness/README.md`](harness/README.md).
