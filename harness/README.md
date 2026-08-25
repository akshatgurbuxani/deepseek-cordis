# Production harness implementation plan

## Outcome

The spike sequence is complete. Production work now promotes the proven
behavior into independently testable packages without importing any source from
`spike/`.

The first usable milestone is a text-only command that sends one user message
to a configured model, allows the model to call one calculator tool, records
the complete turn as immutable session events, prints a trace, and exits after
all Cordis-owned resources are disposed.

This directory contains maintained harness code. Unlike a spike, every package
must have a stable responsibility, public exports, dependency boundaries, and
tests that survive implementation replacement.

## Decisions inherited from the spikes

- TypeScript and ESM remain the implementation language and module format.
- Production composition uses exactly pinned upstream `cordis`; the educational
  runtimes from Spikes 001–005 are not promoted.
- The event log is the source of truth. Model-visible history is projected from
  immutable events rather than stored in a parallel transcript.
- Models, tools, sessions, and storage are replaceable capabilities.
- Capability contracts do not import Cordis. A dedicated adapter package owns
  all Cordis types and compiler exceptions.
- Application boot, not a capability package, owns manifest identity,
  replacement order, and last-known-good rollback.
- Real credentials remain in ignored environment files and never enter events,
  model requests, traces, fixtures, or commits.

## Target package graph

```text
session             ──> protocol
model               ──> protocol
tools               ──> protocol
agent-loop          ──> protocol + session + model + tools
runtime-cordis      ──> agent-loop + session + model + tools + cordis
app-boot            ──> runtime-cordis
model-openrouter    ──> protocol + model
tool/storage plugins──> protocol + their capability contract
cli                 ──> app-boot + selected provider plugins
```

An arrow `A → B` means package A imports package B. The CLI also imports the
selected concrete providers to assemble them through app boot; providers never
import the CLI or app boot.

### `protocol`

Owns values shared across capability boundaries: `JsonValue`, `ToolCall`, tool
schemas and execution results, model messages and requests/responses, session
events, and turn results. It contains types and pure snapshot helpers
only—no registries, stores, network calls, or Cordis imports.

### `session`

Owns the `Session` and `SessionStore` contracts plus the first in-memory
implementation. It appends immutable, monotonically sequenced events and
projects model-visible messages. Storage persistence is a later provider, not
a reason to weaken the initial contract.

### `model`

Owns the provider-neutral `ModelAdapter` contract. A deterministic replay
adapter is exposed from a testing subpath so agent-loop tests do not depend on
a network provider.

### `tools`

Owns the registry contract and in-memory registry. Registrations return
idempotent disposers; schemas are immutable snapshots; missing tools and thrown
handlers produce explicit execution results.

### `agent-loop`

Consumes session, model, and tool contracts. It owns turn/step progression,
model-history projection, ordered tool execution, failure events, per-session
run exclusion, and the maximum-step guard. It knows nothing about Cordis,
OpenRouter, CLI arguments, or persistence.

### `runtime-cordis`

Declares Cordis context services and adapts capability providers and the loop
into plugins. It alone depends on `cordis@4.0.0-rc.8` and uses the compiler
settings required by that package's current declarations.

### `app-boot`

Owns declarative composition, stable entry IDs, ordered mounting, replacement,
and last-known-good rollback. It consumes `runtime-cordis` but capability
packages do not consume it.

### Provider and application packages

`model-openrouter` implements `ModelAdapter` and owns only HTTP wire mapping,
response validation, and provider errors. Concrete tool/storage packages
implement their contracts. `cli` assembles them through app boot and owns human
input/output and trace formatting.

## PR 1: Core contracts and reference implementations

Branch: `feature/001-harness-core-contracts`

This branch establishes an npm workspace and adds only:

```text
package.json
package-lock.json
tsconfig.base.json
tsconfig.json
harness/
  README.md
  protocol/
  session/
  model/
  tools/
```

Each package receives its own `package.json`, TypeScript project, source entry,
tests, and README. Package exports point to build output; tests must exercise
public package imports after a build rather than reaching through another
package's `src/` directory.

### Required behavior

- Events and all nested JSON data are cloned and frozen on ingress.
- Session event sequences start at one and remain append-only.
- Projection includes user/assistant messages, assistant tool calls, and tool
  results while excluding turn/step bookkeeping.
- Duplicate session IDs fail explicitly.
- Duplicate tool names fail explicitly.
- Tool disposal is idempotent and cannot remove a newer registration.
- Tool arguments and outputs are isolated snapshots.
- Missing and throwing tools return explicit failed executions.
- Replay adapters snapshot requests and responses and fail when exhausted.
- Public declarations contain no `cordis` or `spike/` imports.

### First-PR acceptance criteria

- `npm install`, `npm run build`, `npm run typecheck`, and `npm test` succeed
  from the repository root.
- The root lockfile pins all production and development dependencies.
- Package dependency direction matches the graph above and contains no cycle.
- Tests import only public package entry points across package boundaries.
- The immutable-event, projection, registry-cleanup, error, and replay scenarios
  from Spike 006 pass in the new packages.
- No agent loop, Cordis plugin, network adapter, CLI, persistence layer, or
  consequential tool enters this PR.
- The root README describes the production directory and records that the
  runtime-selection question is closed.

### PR 1 result

Implemented the root npm workspace and four public packages. TypeScript project
references build dependencies in graph order, package exports resolve compiled
JavaScript and declarations, and tests exercise package names through npm
workspace links.

Eleven tests cover recursive snapshots, cyclic freeze safety, immutable and
sequenced events, model-message projection, duplicate sessions and tools,
idempotent tool cleanup, schema/input/output isolation, contained tool errors,
replay snapshots, and replay exhaustion. Native coverage reports 100.00% lines,
branches, and functions for all executable production modules.

Verified from the repository root:

```sh
npm install
npm run clean
npm run build
npm run typecheck
npm test
```

The installed and emitted dependency graph contains no import from `spike/` or
`cordis`. Agent-loop and runtime concerns remain deferred to the next PRs as
planned.

## Follow-on PR stack

### PR 2: `feature/002-agent-loop`

Implement the bounded loop against public capability contracts. Port the full
Spike 006 turn trace, deterministic replay, live-schema refresh, concurrent-turn
guard, model failure, missing/throwing tool, and step-limit tests.

#### PR 2 result

Implemented a stable, reconnectable `AgentLoop` facade using only public
protocol, session, model, and tool imports. The loop records all turn and step
facts, reconstructs each model request from session events, reads tool schemas
at every step, executes calls in model order, and closes failures durably.

Eleven agent-loop tests cover the complete tool round trip, deterministic
replay, live schema removal, tool replacement, missing and throwing tools,
model replacement through reconnection, Error and non-Error model failures,
step limits, concurrent-turn exclusion, retryable disconnect, foreign sessions,
and invalid limits. Together with PR 1, all 22 tests pass and native coverage
reports 100.00% lines, branches, and functions for every executable production
module.

The package contains no Cordis, configuration, network, CLI, or persistence
dependency. Those lifecycle and provider concerns remain in the following PRs.

### PR 3: `feature/003-cordis-runtime`

#### Outcome

Add `@deepseek-cordis/runtime-cordis`, the only production package allowed to
import Cordis. It adapts the provider-neutral session, tool, model, and agent
loop capabilities from PRs 1–2 into Cordis services and plugins without moving
domain behavior into the runtime layer.

At the end of this PR, a public Cordis `Context` can compose an in-memory
session store, tool registry, model adapter, tool definition, and stable
`AgentLoop`. Cordis owns availability, dependency-driven activation, service
withdrawal, and effect cleanup. The existing capability objects continue to
own events, tool execution, model completion, and turn progression.

#### Package and dependency changes

Add exactly pinned `cordis@4.0.0-rc.8` to the root lockfile and create:

```text
harness/runtime-cordis/
  README.md
  package.json
  tsconfig.json
  src/
    index.ts
    README.md
  test/
    runtime-cordis.test.ts
```

The package depends on `agent-loop`, `session`, `model`, `tools`, and Cordis.
No dependency edge points back from a capability package into
`runtime-cordis`. Production code must not import any `spike/` source.

Cordis's published declarations require `moduleResolution: "Bundler"` and do
not support the repository's current `verbatimModuleSyntax` setting. Override
those options only in the Cordis-facing build and test configuration; keep the
stricter shared settings unchanged for all provider-neutral packages. Record
the exception in the package README so a future Cordis upgrade can retest and
remove it.

#### Public adapter surface

Use TypeScript declaration merging to add these typed services to Cordis
`Context`:

- `sessions: SessionStore`
- `tools: ToolRegistry`
- `model: ModelAdapter`
- `agentLoop: AgentLoop`

Expose narrow plugin factories for the production contracts:

- a session-store provider plugin;
- a tool-registry provider plugin;
- a model-adapter provider plugin;
- an effect-owned tool-registration plugin; and
- an agent-loop plugin that requires all three providers, connects one stable
  facade through `context.effect()`, and provides it as `agentLoop`.

Factories may return the plugin together with the stable value they close over
when callers or tests need that identity. Plugin names, `inject` declarations,
and `provide` declarations must be explicit enough for lifecycle diagnostics.
Do not expose a generic application container or duplicate Cordis's context,
fiber, dependency, or effect abstractions.

#### Lifecycle behavior to promote

Port the behavioral evidence from Spike 007 against the production packages:

1. Mount the loop before its dependencies and prove its fiber remains pending.
2. Mount sessions and tools and prove the loop is still pending without a
   model.
3. Mount the model and prove the same fiber activates and runs a complete
   model/tool/model turn.
4. Register a tool through a Cordis-owned effect, dispose its fiber, and prove
   its schema and handler are withdrawn exactly once.
5. Replace that tool and prove a later turn observes the replacement without
   replacing session history.
6. Dispose and replace a model provider, then prove Cordis drains and
   reconnects the same `AgentLoop` facade to the new adapter.
7. Create two derived contexts that inherit sessions and tools while isolating
   `model` and `agentLoop`; prove both realms resolve and run independently.
8. Prove nested Cordis effects recover once in reverse acquisition order.
9. Dispose the loop fiber and prove the `agentLoop` service is withdrawn and
   the stable facade rejects later runs as disconnected.
10. Dispose every mounted fiber and prove all registrations and connections
    are reclaimed with no live capability left behind. Cordis does not expose
    a public root-context disposer, so the application layer must retain and
    dispose the fibers it mounts.

The replacement tests in this PR exercise Cordis lifecycle behavior directly.
They may use a small test-only mounting helper, but the production package must
not introduce manifest identity, revision comparison, ordered reconciliation,
or last-known-good restoration.

#### Failure and cleanup rules

- A consumer must not activate until every declared service exists.
- Tool registration and loop connection must be acquired through
  `context.effect()` so their existing idempotent disposers remain the cleanup
  authority.
- A model or registry withdrawal must deactivate the loop before the provider
  is recovered.
- Provider replacement must preserve the loop facade and session-store objects
  when those providers were not themselves replaced.
- Disposal must be awaitable and leave no published `agentLoop` service, tool
  registration, or active connection.
- Activation failures must remain visible through the rejected Cordis fiber.
  Restoring a previous manifest after a failed candidate is deliberately not a
  runtime-cordis responsibility.

#### Acceptance criteria

- `npm install`, `npm run clean`, `npm run build`, `npm run typecheck`, and
  `npm test` succeed from the repository root.
- The root lockfile records exactly `cordis@4.0.0-rc.8` and its integrity.
- Tests consume only public production package exports and public Cordis APIs.
- The package contains no copied educational runtime, private Cordis import,
  loader, configuration, network, CLI, or persistence code.
- Lifecycle tests cover pending activation, complete turn execution,
  effect-owned tool cleanup, tool and model replacement, stable loop identity,
  isolation, LIFO recovery, loop disposal, and full mounted-fiber cleanup.
- Native coverage remains 100% for executable project-owned
  `runtime-cordis` code; upstream Cordis code is not part of the coverage
  target.
- `harness/runtime-cordis/src/README.md` explains the implementation beside the
  source in the same style as the earlier spike walkthroughs.

#### PR 3 result

Implemented `@deepseek-cordis/runtime-cordis` as the sole production Cordis
integration boundary. Five narrow factories publish session, tool-registry,
model, and stable agent-loop services or acquire an effect-owned tool
registration. The adapter imports only public package entry points and contains
no loader, reconciliation, rollback, network, persistence, or spike dependency.

Seven lifecycle tests prove pending activation, a complete model/tool/model
turn, exactly-once tool cleanup and replacement, model withdrawal and stable
loop reconnection, isolated model realms, LIFO recovery, rejected activation,
loop withdrawal, and full mounted-fiber cleanup. Together with PRs 1–2, all 29
tests pass. Native coverage reports 100.00% lines, branches, and functions for
the executable `runtime-cordis` module.

The root lockfile pins `cordis@4.0.0-rc.8` with its published integrity. Cordis's
current declaration compatibility overrides are isolated to the adapter build
and its test typecheck; provider-neutral packages retain the shared NodeNext and
`verbatimModuleSyntax` settings.

Verified from the repository root:

```sh
npm install
npm run clean
npm run build
npm run typecheck
npm test
node --test --experimental-test-coverage harness/runtime-cordis/test/runtime-cordis.test.ts
```

#### Explicitly deferred to PR 4

`runtime-cordis` does not decide which configured plugin revision should be
active. Stable manifest IDs, ordered mounting, candidate replacement,
last-known-good rollback, and reconciliation after failed activation belong to
`app-boot`. This separation keeps Feature 3 a lifecycle adapter rather than a
second plugin loader.

### PR 4: `feature/004-app-boot`

Add `@deepseek-cordis/app-boot`, a declarative transaction layer over
`runtime-cordis`. Each entry has a stable ID, explicit revision, optional
ownership parent and enabled flag, optional target context, and async plugin
loader. Reconciliation must validate before loading, preload before mutation,
preserve unchanged fibers, remove leaves before parents, mount parents before
children, serialize concurrent submissions, and commit metadata only after the
candidate graph settles.

Loading failure must leave the exact live graph untouched. Activation failure
must dispose candidate fibers and restore retired last-known-good plugins before
rejecting. If restoration fails, preserve both failures in an `AggregateError`.
The package owns no file watcher, configuration parser, ESM cache invalidation,
network provider, CLI, or arbitrary private-state migration.

#### PR 4 result

Implemented stable manifest handles, revision and context diffing, inherited
enablement, deterministic mounting and teardown, no-op rereads, queued
transactions, preload isolation, compensating rollback, aggregate recovery
errors, and awaitable full shutdown. `app-boot` imports its lifecycle vocabulary
only through `runtime-cordis`; the adapter remains the sole direct production
Cordis dependency.

Eight app-boot tests exercise a dependency-ordered calculator boot, tool
replacement with retained session history, failed model activation and restored
runnability, load-failure identity, parent subtree disabling, validation,
queued convergence, context movement, rollback failure reporting, and cleanup.
Together with PRs 1–3, all 37 tests pass. Native coverage reports 97.19% lines,
92.86% branches, and 91.67% functions for `app-boot`; the remaining paths are
defensive invariant and recovery branches, including Cordis operations whose
public implementation does not currently reject synchronously or during fiber
disposal.

Verified from the repository root:

```sh
npm install
npm run clean
npm run build
npm run typecheck
npm test
node --test --experimental-test-coverage harness/app-boot/test/app-boot.test.ts
```

### PR 5: `feature/005-openrouter-cli`

Promote the OpenRouter wire adapter, routing diagnostics, tracing wrappers, and
text CLI. Support `.env`, `OPENROUTER_MODEL`, replay mode, and one calculator
tool. Run network tests only when a key is present; deterministic tests remain
the required CI gate.

### PR 6: `feature/006-persistent-sessions`

Add a persistent session-store provider, restart/resume tests, atomic append,
and schema migration policy. The in-memory provider remains useful for tests.

### Later milestones

Add streaming and cancellation before parallel tools. Add compaction only after
the persistent log can prove which history produced each summary. Add approval
and sandbox boundaries before filesystem, shell, browser, or other
consequential tools. Subagents, attachments, scheduling, and UI remain outside
the first production milestone.

## Promotion rules

Spikes are specifications, not dependencies. Production code may reuse the
observed behavior and vocabulary, but it must be written behind the package
contracts above. When behavior differs, add a production test and document why;
do not silently preserve an accidental spike implementation detail.

Every PR must state:

- the invariant it promotes;
- the public API it introduces or changes;
- package dependency changes;
- deterministic verification commands;
- known failure and cleanup behavior; and
- what remains intentionally deferred.
