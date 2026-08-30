# Tools

`@deepseek-cordis/tools` defines the tool registry contract and provides an
in-memory implementation.

A registration returns an idempotent disposer. Schemas, handler inputs, and
successful outputs cross the boundary as immutable snapshots. Missing tools and
handler failures return explicit failed executions so an agent loop can record
and show them to the model instead of losing the turn.

Execution receives the active turn's optional `AbortSignal`. Cooperative tool
handlers can stop pending work, and the registry rethrows cancellation instead
of converting it into an ordinary failed tool result. This lets the loop close
the turn as aborted without inventing model-visible output.
