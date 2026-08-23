# How the minimal harness slice works

Spike 006 is the first experiment that performs recognizable agent work. The
earlier spikes supply lifecycle, dependency, transition, isolation, and loader
behavior; this spike composes those mechanisms into an append-only session, a
tool registry, a model adapter, and a bounded agent loop.

The session log is the source of truth. `Session.append()` snapshots and freezes
each event, assigns its next sequence number, and never updates or deletes an
older event. Turn boundaries, user input, model output, tool calls, tool results,
and failures all pass through this method.

`Session.projectMessages()` derives the transcript visible to a model. User and
assistant messages become ordinary model messages. An
`assistant/tool-calls` event reconstructs the assistant's requested calls, and
`tool/result` reconstructs the results. Turn and step bookkeeping is durable
but not model-visible. There is no second transcript stored by the loop.

`SessionStore` owns sessions by stable ID. In this spike it is in memory, but
the service boundary allows a persistent implementation later without changing
the loop contract.

`ToolRegistry` owns live tool definitions. Registration returns an idempotent
disposer, and `toolPlugin()` places that disposer in the plugin activation's
effect stack. Removing the plugin therefore removes both the model-visible
schema and executable handler. Tool inputs and outputs are snapshotted so a
handler cannot mutate recorded arguments after execution.

Every tool name also receives an internal ownership service key. This marker is
not model-visible. It tells the lifecycle runtime that the old and new versions
of the same tool are provider replacements, forcing the new registration to
wait until the old one drains. Without the marker, two effect-only plugins could
briefly overlap and both try to register the same name during HMR.

Tool execution contains ordinary handler failures. A missing tool or thrown
handler becomes `{ ok: false, error }` rather than escaping the agent turn. The
loop records that result, and the next model request observes it through session
projection.

`ModelAdapter` is a provider-neutral completion seam. A request contains only
the session ID, turn ID, step number, projected log messages, and tool schemas
read from the live registry at that step. A response is either a final assistant
message or ordered tool calls.

`ReplayModelAdapter` is the deterministic provider used by tests. It consumes a
fixed response script and snapshots every request it receives. Two runs with
the same input, tools, and script therefore produce structurally identical
requests and events.

`AgentLoop.connect()` attaches one loop facade to the current session, tool, and
model providers. The connection disposer is effect-owned by `agentLoopPlugin()`.
When a provider is replaced, the Spike 004 runtime drains and reconnects the
loop against the new committed dependency view while preserving the facade
object published under `agentLoopService`.

`AgentLoop.run()` rejects an unknown session or a concurrent second turn for the
same session. It appends `turn/start` and `user/message`, then repeats a bounded
step:

```text
append step/start
derive messages from the event log
read current tool schemas
call the committed model adapter
    ├── message → append assistant/message → close step and turn
    └── calls   → append calls → execute and append each result → next step
```

Model failure closes both the step and turn with durable failure events before
the error escapes. Reaching `maxSteps` appends a durable turn error and failed
turn end. The `finally` block always releases the session's run lock, so a later
turn can proceed after either failure.

The four plugin helpers expose the composition:

- `sessionPlugin()` provides the session store.
- `toolRegistryPlugin()` provides the registry.
- `toolPlugin()` requires the registry and owns one registration effect.
- `modelPlugin()` provides one adapter.
- `agentLoopPlugin()` requires all three services and provides the loop.

Spike 005 manifests give these components stable configuration identities and
revisions. Model replacement reactivates the loop against the new adapter.
Tool replacement swaps the effect-owned registration. Failed model reload
causes Spike 005 to restore the old adapter, after which the same session and
loop continue running.

Overall, the slice establishes one strict data direction:

```text
plugins provide capabilities
        ↓
agent loop consumes capabilities
        ↓
all model-visible facts enter the session log
        ↓
the next model request is projected from that log
```

That direction makes replay possible and keeps lifecycle replacement separate
from conversation history.
