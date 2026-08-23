# Tools

`@deepseek-cordis/tools` defines the tool registry contract and provides an
in-memory implementation.

A registration returns an idempotent disposer. Schemas, handler inputs, and
successful outputs cross the boundary as immutable snapshots. Missing tools and
handler failures return explicit failed executions so an agent loop can record
and show them to the model instead of losing the turn.
