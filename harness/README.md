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

### PR 3: `feature/003-cordis-runtime`

Add the exact Cordis pin and plugin adapter. Port Spike 007 lifecycle parity:
pending activation, effect-owned registrations, provider replacement, stable
loop reconnection, isolated models, LIFO cleanup, and disposal.

### PR 4: `feature/004-app-boot`

Implement stable manifest entries, ordered reconciliation, model/tool
replacement, and last-known-good restoration. The boot layer must prove that a
failed candidate leaves the previous composition runnable.

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
