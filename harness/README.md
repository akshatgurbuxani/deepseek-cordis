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
session-file        ──> session + protocol
compaction          ──> session + model + protocol
token-meter         ──> session + protocol
context-budget      ──> agent-loop + compaction + token-meter
model               ──> protocol
approval            ──> protocol
sandbox             ──> protocol
sandbox-workspace   ──> sandbox + tools + protocol
filesystem          ──> (provider-neutral contract and policy)
system-prompt       ──> protocol
workspace-instructions──> system-prompt + protocol
configuration       ──> protocol
filesystem-workspace──> filesystem + sandbox + system-prompt + tools + protocol
process             ──> (provider-neutral contract)
process-workspace   ──> process + sandbox + system-prompt + tools + protocol
commands            ──> session + protocol
command-session     ──> commands + compaction + session
tools               ──> protocol + approval + sandbox
agent-loop          ──> protocol + session + model + approval + sandbox + system-prompt + tools
runtime-cordis      ──> agent-loop + approval + sandbox + system-prompt + commands + compaction + token-meter + session + model + tools + cordis
app-boot            ──> runtime-cordis
model-openrouter    ──> protocol + model
tool/storage plugins──> protocol + their capability contract
cli                 ──> configuration + app-boot + selected provider plugins
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
projects model-visible messages. `session-file` implements that unchanged
contract with versioned JSON documents and atomic replacement; the in-memory
implementation remains the default for tests and ephemeral commands.

### `model`

Owns the provider-neutral `ModelAdapter` stream contract and shared terminal
collector. A deterministic replay adapter is exposed from a testing subpath so
agent-loop tests do not depend on a network provider.

### `compaction`

Owns optional history compaction at a maintenance boundary. It selects a complete
closed-turn prefix, asks an injected summarizer for a checkpoint, revalidates
the selected surface, and atomically appends exact sequence provenance. Its
model-backed adapter uses the canonical model stream seam.

### `token-meter` and `context-budget`

`token-meter` produces revisioned, immutable pressure estimates over the exact
derived surface and live tool schemas. `context-budget` combines that estimate
with adapter-owned capacity and the optional compactor. It is an agent-loop
policy, not hidden loop behavior: proactive actions, overflow recovery, and
their outcomes are durable decisions with bounded retries.

### `tools`

Owns the registry contract and in-memory registry. Registrations return
idempotent disposers; schemas are immutable snapshots; missing tools and thrown
handlers produce explicit execution results; cancellation remains a control
signal rather than a model-visible tool failure. Harmless definitions own local
handlers; consequential definitions instead declare approval and sandbox
requirements and execute only through provider-owned leases.

### `approval` and `sandbox`

Own independent, provider-neutral safety seams. Approval returns one closed,
one-shot outcome for an exact call. Sandbox providers preflight an exact call,
report actual enforcement strength, own execution, and expose deterministic
lease cleanup. Neither package imports Cordis or supplies a permissive default.

### `filesystem` and `filesystem-workspace`

`filesystem` owns opaque targets, bounded operation contracts, stable `FS_*`
errors, and session-scoped observation/version policy without importing Node,
tools, sandbox, or Cordis. `filesystem-workspace` is the selected Node provider
and model-facing exact-call adapter. It confines portable relative paths to a
real workspace root, rejects symbolic-link traversal, and reports partial
enforcement honestly.

### `process` and `process-workspace`

`process` owns the provider-neutral request, result, output, and error contracts
for foreground executable-plus-argv work. `process-workspace` supplies local
Node and Docker providers, exact consequential-tool leases, and tool-specific
prompt guidance. The local provider confines argv/cwd/environment/lifecycle and
reports partial enforcement. The Docker provider adds fail-closed preflight, a
read-only root, no network, dropped capabilities, resource bounds, and one
writable workspace mount before reporting full enforcement within its explicit
Docker trust boundary.

### `system-prompt`

Owns provider-neutral ordered prompt registration and per-session shadowing.
Dynamic sections receive exact request identity, visible tool schemas, and the
turn signal; assembly returns one immutable prompt without importing a model
adapter, the agent loop, concrete tools, or Cordis.

### `workspace-instructions`

Owns bounded Node discovery for `AGENTS.md`/`CLAUDE.md` project guidance and
adapts each fresh snapshot into one dynamic system-prompt section. It discovers
base and local-overlay candidates from a marked project root to the configured
working directory, retains relative provenance, and prevents symbolic-link
instruction files from crossing the explicit workspace boundary.

### `configuration`

Owns the versioned application-profile vocabulary and pure validation. It
normalizes unknown JSON into one detached immutable profile, rejects unknown or
incompatible fields, and supplies explicit defaults. It does not read files,
resolve paths, inspect environment variables, construct providers, or import
Cordis; the CLI owns those application-layer concerns.

### `agent-loop`

Consumes session, model, tool, safety, and prompt contracts. It owns turn/step progression,
model-history projection, ordered tool execution, failure events, per-session
run exclusion, stream collection, cooperative cancellation, and the
maximum-step guard. It knows nothing about Cordis, OpenRouter, CLI arguments,
or persistence.

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

Add two packages. `model-openrouter` implements only the provider-neutral model
contract: current chat-completion wire mapping, tool schema and history
translation, strict response normalization, explicit provider errors, token
usage, and permissively decoded router metadata. `cli` owns argument and
environment input, trace formatting, the calculator composition, final output,
and process exit behavior.

The required path is deterministic replay with no credential or network. Live
mode uses Node's built-in `.env` loading, requires `OPENROUTER_API_KEY`, defaults
`OPENROUTER_MODEL` to `openrouter/free`, and accepts optional app-attribution
values. Live tests are opt-in; injected-fetch tests remain the CI gate.

The command must build its providers and consumer through an `AppBoot` manifest,
record the complete immutable turn, print a visible trace and final answer, and
reconcile to an empty manifest in `finally`. Credentials must never enter a
model request, session event, diagnostic, trace, fixture, error message, or
commit.

#### PR 5 result

Implemented the provider-neutral OpenRouter adapter against the current
official chat-completions, local tool-calling, app-attribution, free-router, and
router-metadata contracts. It uses the current `X-OpenRouter-Title` header,
disables parallel tool calls to match ordered harness execution, snapshots
normalized outputs, and keeps the API key only in a private field and
Authorization header.

Implemented a one-shot traced CLI with deterministic replay and live OpenRouter
modes. Its AppBoot manifest composes the session store, registry, calculator,
model, and loop; the command prints the final answer and drains all five fibers
on success or failure. Required tests use injected HTTP responses, while a live
smoke test requires both `OPENROUTER_LIVE_TEST=1` and a key.

Twelve new required tests cover provider wire mapping, usage and routing
diagnostics, immutable normalized output, attribution headers,
HTTP/network/malformed response containment, secret isolation, argument
parsing, tracing, mocked-live and replay compositions, failure cleanup,
defaults, and process exit behavior. A thirteenth live smoke test is opt-in.
Together with PRs 1–4, 49 deterministic tests pass and one live test is skipped
by default. Native coverage reports 100% lines and functions for project-owned
`model-openrouter`, CLI orchestration, and tracing code.

Verified from the repository root:

```sh
npm install
npm run clean
npm run build
npm run typecheck
npm test
npm run cli:replay -- "add 17 and 25"
```

### PR 6: `feature/006-persistent-sessions`

Add `@deepseek-cordis/session-file`, a provider for the existing `SessionStore`
contract. It stores one schema-versioned JSON document per session and derives
safe filenames from session IDs. Every create, append, and migration writes a
same-directory temporary file, flushes it, and atomically renames it before
publishing the new state in memory. The store supports the versionless V0
format, rewrites it to V1, and refuses unknown future versions or corrupt event
streams without silently changing their files.

The CLI selects this provider when `HARNESS_SESSION_DIR` is set. Reusing
`HARNESS_SESSION_ID` loads the prior immutable event stream, so the next agent
turn keeps its history and receives the next turn number. Without these values,
the existing in-memory one-shot behavior is unchanged. Tracing decorates either
provider instead of inheriting from the memory implementation.

#### PR 6 result

Implemented crash-safe file replacement, strict runtime validation of every
event variant and contiguous sequence, V0-to-V1 migration, traversal-safe
hashed filenames, copied event views, and model-history projection shared with
the in-memory provider. The documented concurrency boundary is one writer per
session directory; cross-process locking is intentionally deferred.

Six provider tests cover restart fidelity, immutable projection, file mode,
failed-write rollback, migration, future-schema preservation, malformed JSON,
invalid sequences and event types, filename integrity, and orphan-file
handling. A CLI integration test runs two fresh application boots against the
same directory and proves the second boot resumes as turn two with both user
messages in projected history. Together with PRs 1–5, 56 deterministic tests
pass and one live OpenRouter smoke test remains opt-in.

### PR 7: `feature/007-streaming-cancellation`

Promote streaming to the provider-neutral model seam and carry one cooperative
turn signal through model and tool execution. A stream emits text deltas and
exactly one terminal finish: completed with a normalized response, failed with
a safe message, or aborted. The shared model collector validates this boundary,
forwards live text, and returns only the terminal response. The session log
therefore remains the source of truth without treating transient partial text as
committed history.

Cancellation closes an open step and turn with the coarse `aborted` outcome. It
does not persist the same-process abort cause, a `turn/error`, partial assistant
text, or a claimed successful tool result. If cancellation interrupts a tool
batch, the loop records conservative failed results for every unanswered call:
started calls have unknown outcomes and later calls were not started. This keeps
the projected provider transcript balanced without claiming that consequential
work was reverted. The original cause remains available only as the runtime
`TurnCancelledError.cause`. A signal aborted before admission leaves no session
events. The per-session run lock and Cordis-owned provider connection still
release at their existing convergence boundaries.

OpenRouter's canonical path now requests server-sent events and terminal usage,
handles keepalive comments and arbitrary network chunk boundaries, streams text,
and assembles indexed tool-call fragments before publishing a completed finish.
The CLI sends `SIGINT` through the turn signal, waits for durable closure and
manifest cleanup, and exits 130. The existing non-streaming adapter method
remains as a compatibility path for direct callers.

#### Upstream motivation and adaptation boundary

This feature was checked on August 30, 2026 against the Cordis paper at
[`0d43a6f`](https://github.com/cordiverse/paper/commit/0d43a6f18004a7b5bf9662c31aa08c3712d232ec)
and DeepSeek Harness at
[`cd5ef81`](https://github.com/deepseek-ai/deepseek-harness/commit/cd5ef8148158c3a752a658978873241fdf8e2bbc).
The paper supplies the ownership rule: live work and its cleanup must remain
attributable to the component that introduced it. DeepSeek supplies the agent
motivation: raw stream chunks have one terminal outcome, the active turn owns
one abort signal shared with tools, and durable cancellation records a coarse
aborted boundary rather than arbitrary signal data.

This repository adapts those invariants to its smaller message/tool-call
protocol. It does not copy DeepSeek's merge-extensible content blocks,
reasoning chunks, usage chunks, retry routing, inbox/steering, agent registry,
or full `BlockAssembler`. Cordis continues to own provider lifecycle through
`runtime-cordis`; Feature 7 changes no Cordis internals or capability direction.

#### PR 7 result

Implemented the stream protocol, shared collector, deterministic replay stream,
turn-scoped cancellation, signal-aware tool execution, OpenRouter SSE parsing,
fragmented tool-call assembly, live CLI output, `SIGINT` handling, tracing, and
durable aborted boundaries. Nine new deterministic tests cover chunk assembly,
malformed and aborted streams, split SSE frames, streamed diagnostics,
fragmented tool calls, model cancellation, tool cancellation, pre-admission
cancellation, CLI cleanup, and signal identity. Together with PRs 1–6, 65
deterministic tests pass and one live OpenRouter smoke test remains opt-in.

### PR 8: `feature/008-session-crash-repair`

Repair an unambiguously open trailing turn while the file session store is
cold. The repair is append-only: it preserves every committed event, emits a
failed result for each unanswered assistant tool call, closes an open step as
`interrupted`, and closes the turn as `interrupted`. Calls with a durable
`tool/call` have unknown outcomes because their external effects may have
occurred; calls requested by the assistant but never started are recorded
separately. A later process always starts a new turn rather than resuming
partial execution.

Repair shares the file provider's atomic whole-document replacement with V0
migration and completes before a session is published. It is idempotent after
commit. Unknown tool transitions, nested boundaries, mismatched IDs, and other
ambiguous tails fail as corruption without rewriting the source document.

#### Upstream motivation and adaptation boundary

This feature was checked on August 30, 2026 against the Cordis paper at
[`0d43a6f`](https://github.com/cordiverse/paper/commit/0d43a6f18004a7b5bf9662c31aa08c3712d232ec)
and DeepSeek Harness at
[`cd5ef81`](https://github.com/deepseek-ai/deepseek-harness/commit/cd5ef8148158c3a752a658978873241fdf8e2bbc),
especially its
[`session-persistence`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/session/session-persistence/README.md)
and
[`session`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/session.md)
documentation. DeepSeek supplies the recovery invariant: preserve the
interrupted final turn, synthesize enough terminal events for a valid durable
trajectory, and never partially resume it. The paper explains why tool effects
cannot be assumed reversible after process loss and why cleanup must stay at an
explicit ownership boundary.

This repository adapts that behavior to its smaller event protocol and
single-writer JSON provider. It does not copy DeepSeek's persistence engine,
block protocol, branch/fork machinery, storage registration, or recovery UI.
The repair is deterministic derivation over committed events, not evidence that
an interrupted external action was rolled back.

#### PR 8 result

Implemented cold-tail analysis, conservative tool-result synthesis, distinct
interrupted step/turn outcomes, atomic migration-plus-repair, and CLI resume
coverage. Four new deterministic tests cover durable and idempotent repair,
started-versus-unstarted tool calls, failed-write rollback, malformed-tail
rejection, and a fresh CLI process resuming only after repair. Together with
PRs 1–7, 69 deterministic tests pass and one live OpenRouter smoke test remains
opt-in.

### PR 9: `feature/009-provenance-compaction`

Add compaction as an optional capability rather than another responsibility of
the agent loop. `SessionCompactor` selects only a complete closed-turn surface
prefix and retains at least the newest closed turn. Its injected summarizer
receives an immutable request containing the exact model messages and source
event sequences. After asynchronous generation, the compactor checks
cancellation, rejects empty output, requires the session to remain idle, and
revalidates the selected prefix before committing.

One `compaction/summary` event atomically stores the checkpoint text,
summarizer identity, and exact `shadowedSequences`. Projection replaces that
prefix with a user-role checkpoint but never deletes source events. A later
checkpoint may shadow the earlier checkpoint sequence, forming a durable chain
back to the original history. Both session providers reject a checkpoint whose
sequence list is not the exact current surface prefix. The file schema advances
to V2 and explicitly migrates valid V0 and V1 documents.

`ModelSummaryAdapter` is a production provider path, not a fixture: it replays
the selected messages through the canonical streaming model collector, appends
a stable checkpoint instruction, forwards cancellation, disables tools for the
summary call, and rejects tool-call output. `runtime-cordis` publishes the
compactor as an optional service whose withdrawal does not disturb sessions or
the loop.

#### Upstream motivation and adaptation boundary

This feature was checked on August 30, 2026 against the Cordis paper at
[`0d43a6f`](https://github.com/cordiverse/paper/commit/0d43a6f18004a7b5bf9662c31aa08c3712d232ec)
and DeepSeek Harness at
[`cd5ef81`](https://github.com/deepseek-ai/deepseek-harness/commit/cd5ef8148158c3a752a658978873241fdf8e2bbc),
especially its current
[`compaction`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/compaction.md)
and
[`session`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/session.md)
contracts. DeepSeek supplies the capability split, append-only provenance,
surface replacement, prefix revalidation, tool-pairing boundary, and
model-prefix replay motivation. The paper supplies the lifecycle rule that an
optional provider owns its live work and must be withdrawable independently.

This smaller harness deliberately uses one atomic summary checkpoint instead
of DeepSeek's multi-event lock, summary, surface-operation, and end bracket.
Whole-turn prefix selection replaces its general positional range algorithm and
preserves tool pairing by construction. It does not copy DeepSeek's token
meter, pruning, automatic pressure/overflow hooks, raw provider output, usage
accounting, manual command, or UI. Those were deliberately outside Feature 9;
Feature 10 adds the policy signals without changing its provenance contract.

#### PR 9 result

Implemented surface nodes with sequence identity, exact-prefix projection,
model-backed and injectable summarizers, guarded compaction, recursive
provenance, file schema V2 migration and validation, restart fidelity, and the
optional Cordis provider. Ten new deterministic tests cover atomic projection,
repeat compaction, tool-pair preservation, model request construction, tool-output rejection,
concurrency and mutation guards, cancellation and empty output, durable restart,
schema corruption, no-op selection, and provider disposal. Together with PRs
1–8, 79 deterministic tests pass and one live OpenRouter smoke test remains
opt-in.

### PR 10: `feature/010-context-budget-policy`

Add an explicitly versioned, provider-neutral token meter and an optional
context-budget policy. The meter estimates the exact projected session surface
plus live tool schemas and retains event-sequence positions across compaction.
Its four-Unicode-characters heuristic is named `four-characters-v1`; it is a
pressure signal, never tokenizer output, usage, or billing data. Exact capacity
remains adapter-owned metadata.

Before each model step, the policy compares the immutable measurement with an
advertised context window and compacts at the configured threshold. Providers
normalize only recognized context failures to `ModelContextOverflowError`.
That error permits one bounded recovery attempt even without capacity metadata,
but the loop retries only after compaction commits a new checkpoint. No useful
prefix, compaction failure, an exhausted retry budget, or a noncanonical error
preserves the original model failure. Cancellation remains authoritative.

Every attempted action appends a log-only `context-budget/decision`. A
successful decision must reference a real prior `compaction/summary`; failed
and no-progress decisions cannot claim one. File schema V3 validates and
migrates this vocabulary. The CLI composes the meter, compactor, and policy in
both replay and OpenRouter modes when configured with exact capacity.

#### Upstream motivation and adaptation boundary

This feature was checked on August 30, 2026 against the Cordis paper at
[`0d43a6f`](https://github.com/cordiverse/paper/commit/0d43a6f18004a7b5bf9662c31aa08c3712d232ec)
and DeepSeek Harness at
[`cd5ef81`](https://github.com/deepseek-ai/deepseek-harness/commit/cd5ef8148158c3a752a658978873241fdf8e2bbc),
especially its
[`token-meter`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/token-meter.md)
contract and
[implemented after-call pressure/overflow recovery note](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md).
DeepSeek
supplies the separation between measurement, adapter capacity, compaction, and
bounded recovery. Cordis supplies the rule that optional capabilities remain
independently owned and withdrawable.

This repository adapts those invariants to its smaller synchronous projection
and one-shot CLI. It does not copy upstream tokenizer registries, async signal
graphs, usage anchoring, model catalogs, command system, or UI. The estimator is
explicitly heuristic; OpenRouter capacity is configured rather than guessed.

#### PR 10 result

Implemented the meter, policy hooks, canonical overflow type, conservative
OpenRouter normalization, between-step compaction, bounded retry, durable V3
decisions, independent Cordis meter service, and end-to-end persistent CLI
pressure coverage. Together with PRs 1–9, 91 deterministic tests pass and one
live OpenRouter smoke test remains opt-in.

### PR 11: `feature/011-provider-token-metadata`

Resolve capacity through the provider-owned model route and anchor pressure to
durable provider input usage without changing Feature 10's immutable meter
contract. `ModelAdapter.resolveInfo()` is optional and asynchronous; the shared
resolver validates its model ID and capacity, while static adapter capacity
remains supported. OpenRouter queries its official `/api/v1/models` catalog,
matches the requested ID or canonical slug, and caches positive or known-absent
metadata. Explicit environment capacity remains an override.

A completed model stream may carry normalized input/output usage. The agent
loop stores successful usage on the assistant event with the exact pre-response
surface sequence list, effective adapter identity, and complete tool schemas.
Projection verifies that provenance and keeps it log-only. File schema V4 adds
the optional anchor and explicitly migrates V0–V3 while rejecting the new field
in legacy documents.

The meter's component breakdown remains the named `four-characters-v1`
heuristic. When a durable provider sample exists, `totalTokens` instead starts
from its exact input count and applies the signed heuristic difference between
the anchored and current surface/tool envelopes. This remains correct across
restart and provenance-preserving compaction because source events are never
deleted. A replaced adapter cannot reuse the previous route's anchor. The
snapshot exposes `source` and anchor metadata so consumers cannot
mistake mixed estimation for billing precision.

#### Upstream motivation and adaptation boundary

This feature was checked on August 30, 2026 against the Cordis paper at
[`0d43a6f`](https://github.com/cordiverse/paper/commit/0d43a6f18004a7b5bf9662c31aa08c3712d232ec),
DeepSeek Harness at
[`cd5ef81`](https://github.com/deepseek-ai/deepseek-harness/commit/cd5ef8148158c3a752a658978873241fdf8e2bbc),
especially its
[`token-meter`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/token-meter/README.md),
[`request/context` design](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.md),
and OpenRouter's official
[`GET /api/v1/models`](https://openrouter.ai/docs/api/api-reference/models/get-models)
contract. The current upstream meter also retains a fixed heuristic for
unanchored content and uses provider usage as a reusable baseline; it does not
claim exact provider tokenization where none exists.

This smaller harness stores a self-contained request anchor on each successful
assistant event rather than adding DeepSeek's request-header/context events,
usage chunks, projections, and route registry. At Feature 11, failed-call
billing, cache token buckets, system prompts, compaction-call billing, and a
general model catalog remained deferred; Feature 16 now extends the same anchor
with its exact system prompt.

#### PR 11 result

Implemented asynchronous model metadata, cached OpenRouter capacity resolution,
normalized usage finishes, durable exact-envelope anchors, V4 persistence,
provider-anchored heuristic deltas, restart/compaction survival, and live CLI
integration. Together with PRs 1–10, 100 deterministic tests pass and one live
OpenRouter smoke test remains opt-in.

### PR 12: `feature/012-tool-safety-boundaries`

Add enforceable approval and sandbox boundaries before any filesystem, shell,
browser, or other consequential tool enters the harness. Tool definitions form
a closed safety union: `risk: none` is the only shape with a host-local handler;
consequential shapes have no handler and must declare a one-shot approval
reason, sandbox profile, and required `full` or `partial` enforcement.
Registrations snapshot this declaration so later caller mutation cannot weaken
it.

The provider-neutral `approval` package identifies an exact
session/turn/call/tool/risk request and returns `allowed-once`, `rejected`,
`cancelled`, or `unavailable`. Missing, throwing, or malformed providers are
unavailable and never grant. The `sandbox` package prepares one exact call and
returns a provider-owned execution lease with reported enforcement and required
idempotent cleanup. It deliberately has no in-process pass-through provider.
Consequential execution requires both capabilities plus a synchronous durable
audit sink; only `allowed-once` reaches sandbox preflight, insufficient
enforcement cannot execute, and every valid lease is disposed.

The agent loop commits log-only `approval/asked`, `approval/decided`, and
`sandbox/prepared` events around this pipeline. A failed audit commit blocks
dispatch. Session schema V5 validates and persists those events, migrates
V0–V4, and prevents the new vocabulary from appearing in legacy documents.
Cordis publishes approval and sandbox as independent required coeffects, so
replacing either drains and reconnects the stable loop. The CLI explicitly
composes fail-closed providers while its calculator remains harmless.

#### Upstream motivation and adaptation boundary

This feature was checked on August 30, 2026 against the Cordis paper at
[`0d43a6f`](https://github.com/cordiverse/paper/commit/0d43a6f18004a7b5bf9662c31aa08c3712d232ec),
upstream Cordis at
[`b912d39`](https://github.com/cordiverse/cordis/commit/b912d3997ab8e819f8b112edc0b8ee0dfd77132d),
and DeepSeek Harness at
[`cd5ef81`](https://github.com/deepseek-ai/deepseek-harness/commit/cd5ef8148158c3a752a658978873241fdf8e2bbc),
especially its
[`approval`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/approval.md),
[`sandbox`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/sandbox.md),
and
[`tool execution pipeline`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/tool-execution-pipeline.md)
contracts. DeepSeek supplies the one-shot fail-closed outcome vocabulary,
durable audit motivation, per-call sandbox policy, and explicit enforcement
fact. Cordis supplies provider withdrawal and replacement ordering.

This smaller harness adapts those invariants as a typed local/consequential
definition split rather than copying DeepSeek's general pre/execute/post
waterfalls, agent-scoped answerer dispatch, per-session permission presets,
shell escalation vocabulary, or platform sandbox implementations. It does not
claim process isolation until a real provider is composed.

#### PR 12 result

Implemented the two capability packages, immutable safety declarations,
one-shot fail-closed approval, provider-owned sandbox leases, enforcement
checks, durable V5 audit events, cancellation-safe cleanup, Cordis provider
replacement, and explicit CLI composition. Together with PRs 1–11, 112
deterministic tests pass and one live OpenRouter smoke test remains opt-in.

### Feature 13 — interactive control plane

Feature 13 adds a provider-neutral slash-command registry, reversible Cordis
registrations, direct `/inspect` and `/compact` session commands, and a genuine
multi-turn `--interactive` CLI. Admitted commands have durable standalone
`command/run` and `command/done` boundaries, never enter model projection, and
are repaired conservatively after a crash. Manual compaction results cite the
summary event that actually committed.

Approval remains channel-neutral: the CLI supplies a one-shot answerer that
maps terminal input into the closed approval vocabulary. Prompt failure and
EOF fail closed, and late cancellation cannot become a grant. This completes
the human decision path without coupling terminal I/O to tools or approval
policy.

#### Upstream motivation and adaptation boundary

This feature follows DeepSeek Harness's command subsystem invariant that a
recognized command runs directly rather than becoming model input, with a
run/done lifecycle around its handler. It also follows the interaction-layer
boundary where each UI supplies command and approval adapters. The local design
keeps only the necessary registry, strict parser, session commands, and CLI
adapter; it does not copy DeepSeek's application renderer, command waterfalls,
or broader UI framework.

#### PR 13 result

Implemented direct multi-turn interaction, four built-in commands, durable V6
command events and crash repair, source-event provenance, channel-owned
approval, reversible command providers, and deterministic process-level tests.

### Feature 14 — workspace file sandbox

Feature 14 adds the first real consequential effect: `create_workspace_file`
is a handler-free tool whose concrete provider alone creates one UTF-8 file
under a configured workspace. The operation is relative-path-only,
no-overwrite, size-bounded, parent-revalidated, and published atomically from a
same-directory temporary inode. Traversal, missing/non-directory parents,
symbolic-link parents, invalid arguments, cancellation before publication, and
provider/profile mismatches fail closed.

The provider reports `partial`, not `full`. Node's portable filesystem API does
not offer an `openat`-style directory capability, so a separate hostile host
process can still race a validated parent path. This limitation is explicit in
the provider contract and documentation. The model never supplies executable
code and the tool definition has no local handler, so this remains a genuine
host-mediated effect boundary rather than an in-process isolation claim.

Approval now includes the immutable exact tool arguments. The interactive CLI
therefore displays the path and content before a one-shot grant; headless mode
still fails closed. Durable `tool/call`, approval, sandbox-prepared, and
tool-result events preserve the entire decision and outcome.

#### Upstream motivation and adaptation boundary

This feature was checked on August 31, 2026 against the Cordis paper at
[`0d43a6f`](https://github.com/cordiverse/paper/commit/0d43a6f18004a7b5bf9662c31aa08c3712d232ec),
upstream Cordis at
[`b912d39`](https://github.com/cordiverse/cordis/commit/b912d3997ab8e819f8b112edc0b8ee0dfd77132d),
and DeepSeek Harness at
[`0a53fb5`](https://github.com/deepseek-ai/deepseek-harness/commit/0a53fb55bea101816fa226bb964ae2bed71c343b),
especially its
[`filesystem capability`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/filesystem.md)
and
[`sandbox contract`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/sandbox.md).
DeepSeek separates provider primitives, policy, and model-facing tools, and
enforces declarative filesystem effects at that capability boundary rather
than pretending arbitrary in-process code is sandboxed.

This smaller harness adapts that principle to the existing exact-call lease.
It deliberately implements only create, not DeepSeek's full read/write/edit,
observation policy, sandbox modes, error taxonomy, or alternate backends.

#### PR 14 result

Implemented the concrete provider, consequential schema, argument-bearing
approval, CLI composition, atomic no-overwrite publication, security boundary
tests, durable audit integration, and explicit enforcement limitations.

### Feature 15 — filesystem capability family

Feature 15 promotes the create-only proof into a provider-neutral filesystem
surface. `FileSystem` resolves provider-owned opaque targets and exposes stat,
bounded non-recursive list, bounded UTF-8 read, version-guarded whole-file
write, and exact single-match edit. Results contain only workspace-relative
display paths; host paths never cross the capability boundary.

The model-facing family contains `read_workspace_file`,
`list_workspace_directory`, `stat_workspace_path`, `write_workspace_file`, and
`edit_workspace_file`. Every operation remains a handler-free consequential
tool, so immutable arguments are approved before a provider-owned exact-call
lease can execute. Feature 14's `create_workspace_file` schema, audit provider
identity, and result shape remain compatible while its implementation now uses
the generalized provider.

Mutation policy is session-scoped and fail closed. A missing-path stat records
confirmed absence before create; stat or read records the opaque version before
replacement; edit specifically requires a prior content read. The lease
captures that exact version and the provider revalidates it immediately before
publication. Target changes fail as `FS_STALE_VERSION`; missing observations
fail as `FS_NOT_OBSERVED`; absent, ambiguous, and non-text edit inputs retain
separate stable codes. Successful mutations refresh the session observation.

The Node provider bounds file content at 1 MiB and directory responses at 200
entries by default. Reads reject NUL-containing and invalid UTF-8 data. Writes
use a same-directory exclusive temporary file, fsync its contents, preserve an
existing file's permission bits, and publish with no-overwrite link or atomic
rename. Temporary artifacts are cleaned after success or failure. Traversal,
absolute paths, foreign/forged targets, symbolic-link targets or ancestors,
non-directory parents, cancellation, oversized content, stale versions, and
unsupported profiles fail before an unintended effect.

#### Upstream motivation and adaptation boundary

The design follows DeepSeek Harness's separation between its provider-neutral
[`fs contract`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/fs/fs/README.md),
[`filesystem subsystem`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/filesystem.md),
and model-facing
[`tool-fs`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/fs/tool-fs/README.md).
It adapts observation guards and stable error vocabulary to this repository's
existing approval/sandbox lease rather than importing upstream implementation
or introducing a second effect runtime. The contracts remain Cordis-free; CLI
composition selects the Node provider.

Enforcement remains `partial`. Opaque TypeScript targets prevent accidental
cross-provider use, not hostile same-process forgery, and portable Node path
APIs cannot eliminate an external ancestor-swap race between validation and
publication. Exact target-version checks cover normal concurrent edits but do
not claim kernel-enforced directory capabilities.

#### PR 15 result

Introduced two packages and five tool schemas, preserved Feature 14
compatibility, composed the provider into the CLI, and added deterministic
coverage for observation isolation, bounds, UTF-8 validation, stale writes,
exact edits, atomic cleanup, permission preservation, links, traversal,
cancellation, approval, and legacy behavior.

### Feature 16 — scoped agent context and system prompt

Feature 16 gives model-facing instructions their own provider-neutral
capability instead of smuggling them into user history or hard-coding them in
the agent loop. `SystemPromptService` owns named ordered sections, synchronous
or asynchronous per-step text providers, deterministic code-unit tie-breaking,
empty-section removal, cancellation, and immutable assembly output. A section
registered for one session shadows a same-named global section only in that
scope; exact idempotent disposers restore the global layer without residue.

`PromptAssemblyContext` contains the session, turn, step, exact visible tool
schemas, and the explicit turn signal. The loop assembles against one
authoritative tool snapshot for the request. Policy can ask for the current
prompt after asynchronous model metadata work; matching assemblies are cached,
while a genuinely changed tool envelope is reassembled before transmission.
The loop itself knows no persona or filesystem wording.

The CLI composes two contributors as Cordis-owned effects: a stable harness
identity and `WORKSPACE_FILESYSTEM_PROMPT_SECTION`. Workspace guidance appears
only when its generalized tools are visible. It teaches relative paths,
inspection before reasoning, stat/read-before-write, read-before-edit, precise
single-match edits, stale-version recovery, and result-confirmed claims. It
never renders the provider's absolute host root.

`ModelRequest.systemPrompt` remains distinct from durable model history, and
OpenRouter emits it as the first native `system` message. Successful provider
usage records the exact rendered prompt alongside the input surface and tools.
`TokenMeter` prices prompt framing and applies signed prompt deltas to
provider-anchored measurements, so proactive compaction still measures the
actual request envelope introduced by this feature.

Cordis publishes the registry as a required loop coeffect. Prompt-section
registrations are reversible effects; provider withdrawal drains the loop and
sections before replacement, then reconnects the same loop facade and session
history. Direct non-Cordis embeddings retain an explicit empty implementation.

#### Upstream motivation and adaptation boundary

This feature was checked on August 31, 2026 against DeepSeek Harness
`0a53fb5`, especially its
[`system-prompt subsystem`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/system-prompt.md)
and
[`system-prompt package`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/core/system-prompt/README.md).
The local design adapts ordered contributors, scope shadowing, dynamic assembly
context, and tool/prompt coherence to the smaller immutable request contract.
It does not copy upstream's waterfall, variable interpolation, complete-prompt
override, tool restriction/order registry, or durable runtime-context stream.

#### PR 16 result

Introduced the provider-neutral registry and Cordis lifecycle adapters, native
OpenRouter system-role mapping, exact usage provenance, prompt-aware token
pressure, capability-owned workspace guidance, scoped/disposal tests, provider
replacement tests, and full CLI request verification.

### Feature 17 — validated configuration profiles

Feature 17 turns the CLI's formerly scattered defaults into one versioned,
fail-loud application profile. `@deepseek-cordis/configuration` accepts unknown
JSON, requires `schemaVersion: 1`, rejects unknown fields, validates closed
vocabularies and numeric bounds, applies explicit defaults, and returns a
detached recursively immutable `HarnessProfile`. It imports only the snapshot
helper from `protocol`; file reads, environment access, provider construction,
Cordis, and credentials remain outside the package.

Schema V1 selects an OpenRouter route or deterministic replay, optional exact
capacity, workspace root and maximum file bytes, memory or file persistence,
the exact visible set of calculator and workspace tools, identity/persona/tool
guidance prompt sections, ask-or-deny approval behavior, and context-pressure
threshold, retention, and overflow-retry limits. Model fields and persistence
fields are discriminated: replay cannot carry an OpenRouter model ID, and
memory persistence cannot carry a directory. Tool IDs are closed, ordered,
and unique.

The CLI accepts `--profile <path>`, `--profile=<path>`, or `HARNESS_PROFILE`.
Profile-owned relative workspace and persistence paths resolve beside that
profile. Command-line replay and the existing model, context-window, workspace,
and session-directory environment values are explicit higher-precedence launch
overlays, preserving prior invocations without making environment state part of
the profile. Credentials remain environment-only.

The normalized profile compiles into the existing stable-ID `AppBoot` manifest:
disabled tools and prompt contributors never mount, an empty workspace tool set
does not construct or validate a filesystem provider, persona text uses its own
Cordis-owned prompt effect, and policy settings reach the real
`ContextBudgetPolicy`. `approval.default: "ask"` uses an available interaction
channel and otherwise fails closed; `"deny"` never invokes the channel and
records explicit policy rejection. Traces record only the profile name, source
kind, selected tool IDs, and safe effective launch facts rather than copying the
document or its paths wholesale.

Profiles are validated and frozen per accepted generation. Invalid JSON,
unsupported versions, invalid fields, and missing profile files fail before
initial `AppBoot` construction, so no partial provider graph exists to clean up.
Feature 20 adds explicit turn-boundary generation replacement; automatic file
watching remains separate.

#### Upstream motivation and adaptation boundary

This feature was checked on August 31, 2026 against DeepSeek Harness
`0a53fb5`, especially its
[`profile composition`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/boot/app-boot/src/profile.ts),
[`shared CLI profile boot`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/apps/cli/src/profile-boot.ts),
and
[`configuration catalog`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/config-catalog.md).
The local design adopts ordered default/profile/launch layers, fail-loud schema
validation, stable composition identity, and launcher-owned path resolution.
It intentionally does not adopt npm bundle discovery, YAML/JavaScript patches,
profile package installation, module fallback healing, or live HMR.

#### PR 17 result

Introduced schema V1 validation, an example coding profile, profile-aware CLI
selection and path semantics, exact tool/prompt manifest enablement,
profile-driven providers and context policy, deny-default interaction behavior,
pre-boot failure guarantees, backward-compatible launch overlays, and
end-to-end verification across replay, OpenRouter, persistence, safety, and
compaction.

### Feature 18 — repository quality baseline

Feature 18 standardized the repository gate around the pinned Node and Biome
toolchain. Workspace registration is checked against TypeScript references,
formatting and lint run through one root configuration, CI and CodeQL use the
same clean-install build/typecheck/test surface, and dependency updates remain
machine-reviewable. Product behavior was intentionally unchanged.

### Feature 19 — bounded workspace instructions

Feature 19 adds `@deepseek-cordis/workspace-instructions`, a Node-backed dynamic
prompt contributor for `AGENTS.md`/`CLAUDE.md` project guidance. An explicit
real workspace boundary contains a configured working directory. Discovery
walks upward only to find the nearest configured project marker, then reads
candidate files from that project root down to the working directory in
broad-to-specific order. Base candidates precede additive local overlays, and
trimmed sibling duplicates render once.

Reads are bounded before publication. `maxSourceBytes` excludes an oversized
source and `maxBytes` caps the complete UTF-8 section; aggregate pressure drops
whole broad files before truncating the most-specific file. Empty or missing
chains add no prompt. Rendered source names are project-relative, repository
text cannot close the package-owned frame, and symbolic-link instruction files
are deliberately ignored rather than followed across the trust boundary.

The provider has no watcher or shared cache. It performs one no-follow open and
a coherent descriptor stat/read/stat snapshot for each model step, so edits and
removals appear on the next request while a file changing during its read is
omitted. Cancellation remains control flow. Each single-session CLI runtime
owns one immutable provider with normal Cordis disposal semantics; embeddings
can use the system-prompt registry's exact session scopes. Tests mount distinct
providers under two session IDs to prove content does not cross scopes.

Schema V1 gains a separate `instructions` object with explicit enablement,
portable working directory, project markers, base/local candidate lists, and
source/aggregate bounds. The separation is intentional: authored persona text
stays text, configuration stays filesystem-free, and only the CLI constructs
the concrete reader. The stable manifest entry composes it beside existing
identity, persona, and tool-guidance contributors.

#### Upstream motivation and adaptation boundary

This feature was checked on September 2, 2026 against DeepSeek Harness
`4e84901`, especially its
[`agent-instructions package`](https://github.com/deepseek-ai/DeepSeek-Harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/context/agent-instructions/README.md).
The local design adopts its project-chain precedence, base/local candidates,
per-directory deduplication, explicit budgets, visible provenance, and
refresh-without-a-watcher model. It adapts delivery to this repository's
existing dynamic system-prompt seam instead of durable sourced user messages,
and rejects final-component symlinks instead of allowing off-tree guidance.
Touch-driven discovery of a newly visited nested scope is deferred until tool
result observation carries a durable directory-scope contract.

#### PR 19 result

Introduced the new package and profile vocabulary, stable CLI composition,
hierarchical discovery, byte-exact rendering, stale-file handling, cancellation
and boundary enforcement, dynamic refresh, session-isolation tests, and a real
two-step OpenRouter request proving an edited instruction reaches the next
model step without leaking the host path.

### Feature 20 — transactional runtime profile reload

Feature 20 adds an explicit `/reload` operator command to the interactive CLI.
It rereads the originally selected profile, validates and resolves it with the
same frozen launch overlays, and prepares every candidate provider before one
awaited AppBoot reconciliation. The profile's effective safe configuration is
hashed into opaque revisions while manifest IDs remain stable. Unchanged
profiles are true no-ops.

Reload admission uses the command registry's existing no-open-turn and
single-command checks. The new admission-only cancellation policy lets an
already-started reconciliation reach commit or rollback instead of reporting a
cancelled operation with indeterminate effects. The CLI commits its current
profile identity only after AppBoot settles successfully. Parse, schema,
compatibility, provider-construction, activation, and compensating rollback
failures are surfaced through the durable command boundary and sanitized trace.

Sessions and their store remain mounted throughout recomposition, as do the
tool, command, and prompt registries and token meter. Model, approval, sandbox,
agent loop/context policy, compactor, persona, workspace instructions, compact
command, and enabled tool registrations can change. The effective persistence
directory cannot change while a session is mounted; a process restart remains
the honest migration boundary.

#### Upstream motivation and adaptation boundary

This feature was checked on September 2, 2026 against DeepSeek Harness
`4e84901`, especially its
[`config hot-reload resilience decision`](https://github.com/deepseek-ai/DeepSeek-Harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/.agents/notes/implemented/bug-fix/2026-07-20-config-hot-reload-resilience.md)
and
[`manual reload command decision`](https://github.com/deepseek-ai/DeepSeek-Harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/.agents/notes/archived/feature/2026-07-21-tui-reload-command.md).
The local design adopts detached candidate validation, awaited compensation,
idle-only operator control, serialized reloads, and last-known-good retention.
It adapts those rules to this repository's typed JSON profile and existing
stable-ID AppBoot instead of importing Loader, Include, YAML patches, or a file
watcher.

#### PR 20 result

Introduced content-revisioned runtime composition, `/reload`, immutable
persistence compatibility, admission-only command settlement, safe reload
tracing, and end-to-end tests proving live persona/tool replacement, unchanged
no-ops, validation rejection, incompatible persistence rejection, provider
preflight failure, and continued use of the last-known-good model graph.

### Feature 21 — guarded workspace command execution

Feature 21 closes the largest gap between a file-editing demonstration and a
usable coding harness: the agent can run focused inspection, build, lint, and
test commands. `@deepseek-cordis/process` defines Cordis-free foreground
process contracts. `@deepseek-cordis/process-workspace` owns the Node runner,
the `run_workspace_command` consequential definition, its exact sandbox lease,
and dynamic model guidance.

The model supplies `program`, `args`, optional workspace-relative `cwd`, and an
optional bounded timeout. The harness never passes model text to a shell. The
configured executable allowlist defaults to `git`, `node`, `npm`, `npx`, and
`rg`; arguments have count, per-entry, and aggregate byte bounds. Working
directories reject absolute paths, parent traversal, and every symbolic-link
component. Stdin is EOF, execution is foreground-only, and model-controlled
environment variables are absent. The CLI constructs a small terminal-friendly
environment from selected launch values and never forwards provider API keys.

Each stream retains a bounded tail and reports truncation. Nonzero exits,
signals, and command timeouts are returned as model-visible result facts rather
than mislabeled infrastructure failures. Turn cancellation remains control
flow. Timeout and cancellation terminate the process group with
SIGTERM-to-SIGKILL escalation on POSIX and the available child-process
equivalent on Windows. Spawn failures are normalized without host-path or
environment disclosure.

Every command crosses the existing one-shot approval and durable safety-audit
pipeline. The sandbox package now routes exact profile names to independently
replaceable providers, allowing filesystem and process capabilities to coexist
without a permissive composite. Leases are exact, single-use, and idempotently
disposable. Profile reload reconstructs process policy transactionally with
the rest of the runtime graph.

The provider deliberately reports `partial`. Structured argv removes shell
interpolation at this boundary and cwd checks prevent accidental workspace
escape, but an allowed executable can still read host paths, access the
network, execute package scripts, or spawn descendants with inherited
authority. The allowlist and approval are policy controls, not an OS sandbox.
Full enforcement requires a platform isolation backend.

#### Upstream motivation and adaptation boundary

This feature was checked on September 2, 2026 against DeepSeek Harness
`4e84901`, especially its
[`bash-local executor`](https://github.com/deepseek-ai/DeepSeek-Harness/tree/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/shell/bash-local),
[`bash tool`](https://github.com/deepseek-ai/DeepSeek-Harness/tree/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/shell/tool-bash),
and
[`bash sandbox`](https://github.com/deepseek-ai/DeepSeek-Harness/tree/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/shell/bash-sandbox).
The local design adopts fresh-process execution, explicit time/output budgets,
process-group termination, credential scrubbing, result-level nonzero exits,
and a separate confinement seam. It intentionally starts with structured argv,
no background jobs, no persistent PTY, no spill files, and no escalation mode;
those surfaces should not precede a stronger isolation backend and demonstrated
workflow need.

#### PR 21 result

Introduced both process packages, profile-routed sandbox composition, explicit
schema-V1 command policy, transactional CLI wiring, command-specific prompt
guidance, direct lifecycle/confinement tests, and an end-to-end OpenRouter turn
proving approval, execution, result delivery, and API-key scrubbing.

## Feature 22 — cross-process session writer coordination

Whole-file atomic replacement prevents torn documents, but it does not prevent
two processes that opened the same revision from independently publishing the
same next sequence number. The later rename would silently erase the earlier
commit. The file provider now coordinates every materialization, append,
migration, and crash repair with an atomic per-session lock and an opaque
content revision. Unrelated session IDs remain independent.

A contender fails fast with `SESSION_WRITE_BUSY` while a live local owner holds
the lock. Once another writer commits, an instance that observed the old
revision fails with `SESSION_STALE_WRITER` and must reopen. It never guesses how
to merge independently derived event streams, and neither its in-memory events
nor expected revision advance before the durable writer returns successfully.

Lock metadata is completely written and fsynced to a same-directory owner file
before an atomic hard link publishes it as the canonical lock. A dead owner on
the same host can therefore be identified by its token, hostname, and PID and
reclaimed without treating a partial file as authority. Live, malformed, and
foreign-host locks fail closed. This is cooperative coordination for a local
filesystem, not a distributed lease; non-cooperating file replacement and
shared network filesystems remain outside the claim.

### Upstream motivation and adaptation boundary

This feature was checked on September 2, 2026 against DeepSeek Harness
`4e84901`, especially its
[`session persistence coordinator`](https://github.com/deepseek-ai/DeepSeek-Harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/session/session-persistence/src/coordinator.ts),
[`opaque revision contract`](https://github.com/deepseek-ai/DeepSeek-Harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/session/session-persistence/src/revision.ts),
and
[`JSON atomic storage`](https://github.com/deepseek-ai/DeepSeek-Harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/storage/storage-json/src/atomic.ts).
The local provider adopts per-identity serialization, revision preconditions,
contiguous append-only history, and durable replacement. It adapts those ideas
to a synchronous whole-document store and deliberately does not introduce a
database, distributed lease service, or event-stream merge policy.

### PR 22 result

Added per-session lock ownership and dead-local recovery, SHA-256 document
revisions, explicit busy/stale conflict errors, coordinated create/append/
migration/repair paths, and real child-process tests for contention, stale
writers, creation races, and crash recovery.

## Feature 23 — persistence stabilization and operational bounds

Feature 23 hardens the local file provider without changing its append-only
session contract or prematurely selecting a new storage engine. A successful
document commit remains the only event publication point. If later canonical
lock removal fails, the completed process-local token becomes reclaimable on
the next write while active, foreign, malformed, and unrelated live locks still
fail closed.

File stores now enforce a 64 MiB default document bound before decoding startup
input or publishing an append. Callers may select a different positive safe
integer explicitly. The bound prevents accidental unbounded reads and writes;
it does not claim that synchronous whole-document replacement is suitably fast
at the maximum size.

A non-gating repository benchmark creates realistic closed turns, records every
append latency, reports final document size and throughput, and cleans up its
temporary directory. This makes the storage decision measurable on deployment
filesystems without introducing timing-sensitive CI assertions.

### PR 23 exit condition

- A committed writer cannot strand the same process behind its completed lock.
- Oversized startup documents and appends fail before live state advances.
- Lock cleanup failure and document bounds have deterministic tests.
- Long-session append cost can be reproduced with
  `npm run benchmark:session-file -- <turns>`.
- Storage replacement remains evidence-driven and outside this feature.

## Feature 24 — platform-backed command sandbox

Feature 24 keeps the existing Node runner as an explicit local/partial backend
and adds an opt-in Docker/full backend. Schema-V1 process profiles discriminate
the backend. Docker selection requires an already-local image and explicit
memory, PID, and tmpfs budgets; missing daemons and images reject initial boot
or reload before runtime reconciliation.

The Docker runner fixes every isolation option before model-controlled input:
no registry pull, no network, read-only root, all Linux capabilities dropped,
`no-new-privileges`, bounded memory/swap/PIDs/tmpfs, one writable workspace bind
mount, exact container cwd, and the allowed program as entrypoint. A unique
container name plus `--rm` and unconditional forced cleanup cover normal exit,
failure, timeout, and cancellation. Provider audit events report
`workspace-process/docker-v1` and `full`; the visible tool requires that same
enforcement, so a partial lease cannot silently satisfy a Docker profile.

The full claim is intentionally scoped. Commands may change any approved
workspace file and trust the operator-selected image plus Docker's daemon,
runtime, and kernel isolation. The harness does not pull or attest images and
does not claim resistance to vulnerabilities below that boundary.

### PR 24 exit condition

- Local profiles retain their existing partial enforcement and behavior.
- Docker profiles fail closed when the daemon or configured image is absent.
- Model values cannot become Docker options, mounts, environment entries, or
  image references.
- Full leases and tool requirements agree in durable safety audit events.
- Timeout and cancellation always attempt named-container cleanup.

### Later milestones

With platform-backed command execution available, the next milestone is coding
tool ergonomics: atomic multi-hunk edits, bounded recursive discovery,
reviewable diffs, and separately approved rename/delete operations. Attachments
can later add useful input without changing loop ordering, while parallel tools
need a durable batch and event-order contract before implementation. Subagents,
scheduling, and UI remain later layers; automatic config watching can be added
when it owns an exact-path watcher and disposal/drain contract.

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
