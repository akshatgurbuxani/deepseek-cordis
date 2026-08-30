# Tools

`@deepseek-cordis/tools` defines the tool registry contract and provides an
in-memory implementation.

A registration returns an idempotent disposer. Schemas, handler inputs, and
successful outputs cross the boundary as immutable snapshots. Missing tools and
handler failures return explicit failed executions so an agent loop can record
and show them to the model instead of losing the turn.

Execution receives the active turn's optional `AbortSignal`. Cooperative tool
handlers can stop pending work, and the registry rethrows cancellation instead
of converting it into an ordinary handler failure. The agent loop remains the
single owner of conservative cancellation results and aborted turn closure.
