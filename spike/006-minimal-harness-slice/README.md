# Spike 006: Minimal harness slice

## Question

Can the lifecycle and composition mechanisms proven in Spikes 001–005 support
one complete, deterministic agent turn whose model-visible inputs, outputs,
tool calls, and tool results are recorded as durable events, while model and
tool providers remain replaceable plugins?

## Why this follows Spike 005

The first five spikes established the infrastructure beneath a harness:

- Spike 001 owns and recovers reversible resources.
- Spike 002 orders consumers and providers.
- Spike 003 converges through in-flight lifecycle changes.
- Spike 004 scopes service resolution and access policy by realm.
- Spike 005 reconciles a declarative composition and restores the last working
  graph after failed reload.

None of them demonstrates useful agent behavior. This spike composes the
smallest vertical slice that exercises every layer: an append-only session log,
a model-adapter seam, a tool registry, and an agent loop.

## Primary sources

- Paper commit [`948a07b`](https://github.com/cordiverse/paper/commit/948a07b369c62adb3b12e102458be5c18dfb69b9),
  especially Section 5 on Cordis composition and the harness case study.
- DeepSeek Harness commit [`b150a55`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e).
- [`docs/architecture.md`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/architecture.md)
  for the session, tools, LLM, and agent-loop service boundaries and durable
  turn flow.
- [`docs/subsystems/core.md`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/subsystems/core.md)
  for the append-only session source of truth and package-by-package control
  spine.
- [`packages/core/agent-loop`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop)
  for the concrete loop boundary.

## Hypothesis

Four runtime services are sufficient for one deterministic vertical slice:

1. `sessions`: owns append-only session events and history projection.
2. `models`: resolves a provider-neutral model adapter.
3. `tools`: owns tool schemas, handlers, and single-shot registrations.
4. `agentLoop`: turns one user input into one or more model steps until the
   model returns a final assistant message.

The agent loop should depend only on these service interfaces. Providers should
register through activation-owned effects, so replacement or removal withdraws
their capabilities through the dependency lifecycle already proven.

## Proposed vocabulary and API

- `SessionEvent`: immutable durable fact with sequence number and discriminated
  event type.
- `Session`: append-only event owner plus a projection into model messages.
- `ModelMessage`: provider-neutral user, assistant, and tool-result message.
- `ModelRequest`: projected history plus currently registered tool schemas.
- `ModelResponse`: either a final assistant message or ordered tool calls.
- `ModelAdapter`: deterministic `complete(request)` seam.
- `ToolDefinition`: name, description/schema, and async handler.
- `ToolRegistry`: effect-owned registrations, schema listing, and invocation.
- `AgentLoop.run(session, input)`: append input and execute steps until a final
  answer or an explicit safety limit.

The intended composition should resemble:

```ts
const host = new DeclarativeHost()

await host.reconcile([
  sessionPlugin,
  toolRegistryPlugin,
  calculatorToolPlugin,
  replayModelPlugin,
  agentLoopPlugin,
])

const result = await host.runtime.get(agentLoop)!.run(session, 'add 2 and 3')
```

## Turn model

```text
append turn/start
append user/message
        ↓
project model-visible history + current tool schemas
        ↓
call model adapter
        ├── final text
        │      ↓
        │  append assistant/message
        │  append turn/end
        │
        └── tool calls
               ↓
           append assistant/tool-calls
           for each call in model order:
             append tool/call
             execute registered handler
             append tool/result
               ↓
           begin next model step
```

Every fact that affects the next model request must first be appended to the
session. The next request must be derived from the log, rather than from a
parallel hidden transcript.

## Boundary

This spike runs one agent loop in memory with deterministic adapters and tools.
It excludes streaming, parallel tool execution, cancellation, steering,
compaction, persistence, attachments, permissions, subagents, retries, token
accounting, UI events, and real network model providers.

Tool arguments are already-decoded JSON values. A minimal schema description is
model-visible metadata, not a full validation framework. The append-only log is
durable in meaning but uses an in-memory store; persistence is outside the
experiment.

The loop must impose a maximum step count so a model that continually requests
tools fails visibly rather than running forever.

## Method

Build the four services as plugins composed through the Spike 005 declarative
host. Use a scripted replay adapter that records every request and returns a
fixed sequence of tool calls and final answers. Register tools through
`Context.effect()` so provider removal proves cleanup. Derive every model
request from session events and compare a complete expected event trace.

Replace the model and tool providers through manifest revision changes. Verify
that the loop follows the new identities, affected consumers reactivate, and
unrelated session history remains intact. Include failed provider reload to
confirm the last-known-good runnable composition is restored.

## Acceptance criteria

- One user input produces a durable `turn/start`, `user/message`, step events,
  assistant output, and `turn/end` trace.
- A scripted model can request a tool, receive its logged result in the next
  projected request, and then return a final answer.
- Every model-visible message is derivable from the append-only event log; no
  hidden transcript influences the next request.
- Tool schemas are taken from the live registry at each model step.
- Removing a tool provider withdraws its schema and handler exactly once.
- Replacing a tool provider changes later execution without disturbing session
  history or an unrelated tool.
- Replacing the model adapter makes the next turn use the replacement identity.
- A failed model-provider reload restores the previous adapter and leaves the
  loop runnable.
- Missing tools and thrown tool handlers produce explicit logged error results
  that the model can observe.
- A model that exceeds the maximum step count closes the turn with a durable
  failure event and does not leak an in-flight run.
- The replay adapter receives the same requests for the same recorded scenario
  across repeated test runs.

## Suggested implementation order

1. Define immutable event and model-message vocabularies.
2. Implement append-only sessions and history projection.
3. Implement effect-owned tool registration and deterministic execution.
4. Implement the model-adapter registry/seam and replay adapter.
5. Implement the bounded sequential agent loop.
6. Compose all services through a Spike 005 manifest.
7. Add the full tool-call turn trace and replay determinism test.
8. Add provider replacement, removal, failure rollback, and loop-limit tests.
9. Record coverage, exact traces, limitations, and the promotion decision.

## Result

Implemented an in-memory session store, effect-owned tool registry,
provider-neutral model seam, deterministic replay adapter, and bounded
sequential agent loop. All services are components composed through the Spike
005 declarative host and the Spike 004 lifecycle runtime.

The complete calculator scenario produced this event sequence:

```text
turn/start
user/message
step/start
assistant/tool-calls
tool/call
tool/result
step/end
step/start
assistant/message
step/end
turn/end
```

The second model request was derived from the log and contained the original
user message, the assistant tool call, and the successful tool result. The
final `Session.projectMessages()` result exactly matched that request plus the
subsequent final assistant event. Running the scenario twice produced identical
event and request structures.

Tool schemas were read live for every step. A self-removing tool completed its
current invocation through a captured definition, disposed its effect-owned
registration, and was absent from the next model request. Stable internal
ownership keys prevented old and new versions of one tool name from overlapping
during HMR.

Replacing a tool changed later execution while preserving session history and
an unrelated tool fiber. Missing and throwing tools produced explicit failed
results visible in the next model request. Replacing the model changed the next
turn's adapter while preserving the session store and loop facade. A failed
model reload restored the previous adapter and the same session completed a
later turn successfully.

Commands run with Node `26.7.0`, npm `11.19.0`, TypeScript `7.0.2`, and
`@types/node` `26.2.0`:

```sh
npm install
npm run typecheck
npm test
node --test --experimental-test-coverage test/*.test.ts
```

Observed result:

- 8 tests passed; 0 failed, skipped, or cancelled.
- TypeScript completed with no errors.
- Native coverage reported 95.33% lines, 83.54% branches, and 100.00% functions
  for `src/harness.ts`.
- The maximum-step guard durably closed a failed turn and released its run lock
  so a later turn could succeed.
- No model-visible hidden transcript existed outside session projection.

## Decision

The six-spike sequence is sufficient to promote the demonstrated behaviors into
a harness design: activation-owned effects, dependency-safe transitions,
realm-scoped service views, stable declarative identity, append-only
model-visible history, effect-owned capability registration, swappable model
adapters, and a bounded loop.

Do not promote these educational source files directly. A production harness
still needs persistent sessions, streaming, cancellation, steering,
permissions, schema validation, parallel tool scheduling, retries, compaction,
attachments, subagents, observability, and crash recovery. The next step should
be an architecture decision choosing upstream Cordis versus a maintained local
runtime, followed by production package boundaries around the promoted
behaviors.
