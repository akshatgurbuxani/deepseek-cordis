# How the Cordis integration works

Spike 007 keeps the harness objects from Spike 006 and changes who composes
them. `SessionStore`, `ToolRegistry`, `ModelAdapter`, and `AgentLoop` still own
agent behavior. Upstream Cordis now owns when those objects are available, when
their consumers start, and when their registrations are cleaned up.

The `declare module 'cordis'` block adds the four harness services to Cordis's
typed `Context`. This is TypeScript declaration merging only; it does not create
any runtime values. Each provider plugin calls `context.provide()` to publish
the actual value under the corresponding name.

`createSessionPlugin()` closes over one `SessionStore`. When Cordis activates
the returned plugin, it publishes that store as `sessions`. The store survives
consumer restarts because it belongs to the provider plugin, not to the agent
loop.

`createToolRegistryPlugin()` does the same for one `ToolRegistry`.
`createToolPlugin()` is different: it does not provide a new Cordis service. It
declares `tools` as a dependency and registers one definition in the existing
registry through `context.effect()`. The returned registration disposer belongs
to the tool plugin's fiber, so disposing that fiber removes the schema and
handler exactly once.

`createModelPlugin()` publishes one provider-neutral `ModelAdapter`. The
optional setup error exists only for the failed-replacement experiment. It
lets the test prove what happens when a candidate provider cannot finish
activation.

`createAgentLoopPlugin()` closes over one stable `AgentLoop` facade. Its
`inject` declaration says that `sessions`, `tools`, and `model` must all be
active first. Cordis leaves the loop fiber pending until they exist. Once they
do, the plugin connects the facade through an owned effect and publishes it as
`agentLoop`.

When a dependency disappears, Cordis unloads the loop fiber. The connection
effect disconnects the facade and the provided `agentLoop` service is
withdrawn. When a replacement appears, Cordis runs the same plugin again and
reconnects the same facade to the new committed provider values. Session state
is not touched because it belongs to the independent session provider.

`mountPlugin()` is a small promise-friendly wrapper around `context.plugin()`.
Cordis returns a fiber that is also thenable; awaiting it means activation has
settled or failed. The wrapper retains both the plugin declaration and its
fiber so boot code can later replace it.

`replaceWithRollback()` demonstrates the responsibility that Cordis core does
not claim for this experiment. It drains the old provider, tries the candidate,
and, if the candidate fails, disposes it and mounts the last working plugin
again. Cordis owns the safe fiber transitions on each side. Harness boot owns
the declarative decision to restore old configuration.

Isolation uses Cordis contexts directly. Two contexts can isolate the `model`
and `agentLoop` names while inheriting `sessions` and `tools` from their parent.
The same service contract therefore resolves to different adapters without
duplicating shared state.

Overall, data and lifecycle ownership are separated:

```text
Cordis context and fibers own availability and cleanup
                         ↓
harness providers own sessions, tools, and model behavior
                         ↓
the stable agent loop consumes the active provider view
                         ↓
harness boot owns declarative replacement and rollback policy
```

This adapter is comparison code. Production packages will define their own
contracts and Cordis plugins rather than importing any spike directory.

## How the visible demo and live model adapter work

`OpenRouterModelAdapter` implements the same `ModelAdapter` interface as the
replay adapter. It converts projected user, assistant, tool-call, and tool-result
messages into OpenRouter's chat-completion wire format. Live tool schemas become
function definitions. Returned function arguments are parsed and checked as
JSON before entering the harness.

The adapter sends the API key only in the HTTP `Authorization` header. The
provider-neutral model request contains no credential, so the tracing wrapper
can safely print it. The normalized response and token-usage metadata are also
printed, while non-success HTTP responses become ordinary model-adapter
failures handled by the agent loop.

`TracingSessionStore` creates a small `Session` subclass whose `append()` method
prints each immutable event immediately after the normal session records it.
`TracingModelAdapter` prints the exact request before delegating and the
normalized response afterward. `traceCordisLifecycle()` listens to Cordis's
public status event and prints every fiber transition.

`demo.ts` composes those tracing pieces with the session, tool, model, and loop
plugins. Replay mode supplies two fixed responses. OpenRouter mode reads the
key and model slug from the environment. Both modes run through the same
Cordis composition, calculator tool, `AgentLoop`, event log, and cleanup path;
only the model adapter changes.
