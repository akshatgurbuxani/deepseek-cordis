# How the production Cordis adapter works

The adapter separates lifecycle ownership from domain behavior. Sessions
append events, registries execute tools, model adapters complete requests, and
`AgentLoop` advances turns exactly as they do without Cordis. Cordis decides
when those objects are available and when their owned effects must be reversed.

The declaration merge adds `sessions`, `tools`, `model`, `compaction`, and
`agentLoop` to the typed public `Context`; it creates no runtime state. Each provider factory
closes over one capability object, explicitly declares the service it provides,
and publishes the object with `context.provide()` when its fiber activates.

The compaction provider is optional and independent of the agent-loop spine;
withdrawing it removes the capability without disturbing active sessions.

The tool-registration plugin requires `tools`. Its registration is acquired
through `context.effect()`, so disposing or deactivating the plugin invokes the
registry's idempotent disposer and withdraws both schema and handler.

The agent-loop plugin requires `sessions`, `tools`, and `model`. It closes over
one stable `AgentLoop`, connects it through an effect, and then publishes it.
Cordis leaves the fiber pending until all three providers exist. If a provider
is withdrawn, Cordis first deactivates the consumer, which removes the service
and disconnects the facade; a replacement provider causes the same facade to
connect again. Session history survives because it belongs to the independent
session-store provider.

Derived contexts can isolate `model` and `agentLoop` while inheriting sessions
and tools. This creates independent model realms without adding another
container abstraction.

Applications must retain every fiber returned by `context.plugin()` and await
its disposal. Cordis has no public root-context disposer. Manifest identity,
replacement ordering, failed-candidate rollback, configuration loading, and
HMR belong to the later `app-boot` package rather than this adapter.

The public `RuntimeContext`, `RuntimeFiber`, and `RuntimePlugin` aliases expose
Cordis's own lifecycle objects to that package without another direct Cordis
import. `RuntimeFiberState` mirrors the numeric values from the exact Cordis
pin because its published ambient `const enum` has no reliable JavaScript
re-export.
