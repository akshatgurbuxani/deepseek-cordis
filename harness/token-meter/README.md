# `@deepseek-cordis/token-meter`

Provider-neutral, revisioned request-pressure measurement.

`TokenMeter.measure()` prices the current derived session surface and tool
schemas into one detached immutable snapshot. `logRevision` identifies the
durable event tail consumed by every field, while positional node sequences
remain correct after compaction replaces an older prefix with a newer event.

The estimator is deliberately named and heuristic: four Unicode characters per
token plus stable role, tool-call, tool-result, and schema framing overhead. It
is suitable for pressure policy, not billing or exact tokenizer claims. Exact
context capacity remains adapter-owned metadata and is never inferred here.
