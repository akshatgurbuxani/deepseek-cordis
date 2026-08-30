# How the production agent loop works

The agent loop is the first production package that coordinates the capability
contracts introduced in Feature 1. It does not implement sessions, models, or
tools itself. Instead, it consumes their public interfaces and defines the
ordering rules that turn one user input into a bounded sequence of model calls
and tool executions.

The file exports `StepLimitError`, `TurnCancelledError`, the turn options, and
`AgentLoop`. The two errors distinguish bounded-loop exhaustion from an
explicit cooperative cancellation without putting runtime error objects into
the session log.

## Dependency boundary

The imports at the top of `index.ts` are intentionally all public package
imports:

- `ModelAdapter` and `completeModel()` provide the streaming model seam and its
  shared terminal collector.
- `ModelResponse` and `RunResult` are shared protocol values.
- `snapshot()` protects the model request at the capability boundary.
- `Session` and `SessionStore` own durable events and message projection.
- `ToolRegistry` supplies live schemas and contains tool execution failures.

There is no Cordis import. Feature 2 defines agent behavior, while the later
runtime adapter decides when providers exist and when the loop is connected or
disconnected. Keeping those concerns separate also lets the tests use an
in-memory session store, registry, and replay model without constructing a
plugin runtime.

## Stable facade and changing providers

An `AgentLoop` instance has three private provider slots: the current session
store, tool registry, and model adapter. The object itself can survive provider
replacement. A runtime can disconnect it from one provider set and reconnect
the same facade to another set, preserving callers that hold the loop and
preserving session history owned by the independent session store.

`connect()` requires all three capabilities together. It rejects a second
connection rather than silently changing only part of the committed provider
view. On success it returns an idempotent disposer. Calling that disposer clears
all three slots together.

The disposer refuses to disconnect while any turn is running. That failure is
retryable: it does not mark the disposer as used, so the runtime can drain the
turn and call it again. Once disconnection succeeds, repeated disposal does
nothing. This behavior is designed for Feature 3, where a Cordis-owned effect
will own the connection disposer.

## Per-session run ownership

`#running` is a set of session objects with active turns. Different sessions
may run concurrently, but the same session object may not start a second turn
until its first turn settles. Serializing turns within one session protects
event order and turn-number allocation without imposing a global loop lock.

Before acquiring that lock, `run()` validates four things:

1. the loop is connected;
2. the supplied session is the exact object owned by the connected store;
3. that session does not already have a running turn; and
4. `maxSteps` is a positive integer; and
5. the supplied signal has not already been aborted.

These checks occur before any event is appended. Invalid ownership, duplicate
work, or an invalid limit therefore cannot leave a partial turn in the log.

## Starting a turn

The default step limit is eight. A caller may override it through `RunOptions`,
but zero, negative, fractional, and other non-positive-integer values fail with
a `RangeError`.

The loop derives the next turn number by counting existing `turn/start` events
and creates a readable ID of the form `session-id:turn:N`. It then acquires the
session's run lock and appends two facts in order:

```text
turn/start
user/message
```

`Session.append()` owns sequence allocation and immutable snapshotting. The
loop never maintains a second mutable transcript.

## Running one model step

Each loop iteration begins with `step/start`. Immediately before calling the
model, the loop builds a request from current capability state:

- `session.projectMessages()` reconstructs model-visible history from events;
- `tools.schemas()` reads the registry's schemas at that exact step; and
- `snapshot()` clones and freezes the complete request.

Reading both history and schemas for every iteration is important. Tool calls
and results from the previous step enter the next request through projection,
and a tool that registered or disposed during execution is reflected in the
next schema list.

The model adapter streams zero or more text deltas and exactly one terminal
finish. `completeModel()` validates that protocol, forwards text through the
caller's `onTextDelta`, and returns one of two completed response shapes.
Streaming does not append partial assistant events: only the terminal response
is a durable model-visible fact.

### Final assistant message

For a message response, the loop appends:

```text
assistant/message
step/end       outcome: completed
turn/end       status: completed
```

It then returns the turn ID, final content, and number of model steps used.

### Tool calls

For a tool-call response, the loop first records the assistant's complete call
list in `assistant/tool-calls`. It then processes calls sequentially in model
order. Each call produces this pair:

```text
tool/call
tool/result
```

The registry converts a missing tool or a handler exception into a failed
execution value, so either success or failure becomes a durable `tool/result`
event. After every call has a result, the loop appends `step/end` with the
`tool_calls` outcome and begins the next model step.

Sequential execution is deliberate. The active turn signal is passed to every
tool execution so a cooperative handler can stop, but parallel scheduling and
its conflict policy remain undefined.

## Failure behavior

If the model stream fails, ends malformed, or the adapter throws, the loop
converts the failure to a durable message, using `Error.message` for ordinary
errors and `String(error)` for non-Error throws. It records:

```text
step/end       outcome: failed
turn/error
turn/end       status: failed
```

The original thrown value is then rethrown, so callers keep the provider's
failure identity while the session retains a replayable explanation of the
closed turn.

Cancellation is deliberately different. One optional signal crosses the model
and tool boundaries. If it aborts during a step, the loop records:

```text
step/end       outcome: aborted
turn/end       status: aborted
```

It does not append `turn/error`, a partial assistant message, an interrupted
tool result, or `signal.reason`. The reason is trusted same-process control data
and may not be JSON-serializable; the durable log retains only the coarse
aborted outcome. `TurnCancelledError` carries the original reason as its
runtime-only cause.

If every allowed step returns tool calls, the loop creates a `StepLimitError`,
appends `turn/error` and a failed `turn/end`, and throws that error. The final
tool-call step already has its own `step/end`, so the turn is complete without
inventing another model step.

The outer `finally` always removes the session from `#running`. A later turn can
therefore proceed after success, model failure, or step-limit failure.

## Complete data flow

```text
connected session, tool, and model capabilities
                    |
                    v
append turn/start and user/message
                    |
                    v
append step/start
                    |
                    v
project messages + read live schemas + snapshot request
                    |
                    v
               stream model
           /         |          \
          v          v           v
    text delta  final message  ordered tool calls
          |          |           |
          v          v           v
     forward live  close turn  record calls/results
                                  |
                                  v
                             next bounded step
```

The important direction is one-way: capabilities produce facts, facts enter
the append-only session, and the next model request is projected from those
facts. Provider replacement changes future work without rewriting earlier
history.

## What Feature 2 intentionally does not own

This file contains no provider discovery, plugin lifecycle, network transport,
persistence, configuration, CLI, parallel tool execution, or rollback policy.
It owns stream consumption and turn cancellation because those determine which
model-visible facts may be committed and how a started turn closes. Providers
own wire chunks; callers own the signal; Cordis still owns provider connection
and cleanup.
