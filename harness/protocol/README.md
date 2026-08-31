# Protocol

`@deepseek-cordis/protocol` owns immutable values shared across harness
capability boundaries. It contains no service implementation, I/O, or Cordis
integration.

`snapshot()` creates a structured clone and recursively freezes it. Providers
use this at ingress so later mutation of a caller-owned object cannot rewrite a
recorded event, model request, tool schema, or tool result.

The model stream vocabulary is also data: text deltas followed by exactly one
`finish` whose reason is `completed`, `error`, or `aborted`. A completed finish
carries the normalized message or tool calls. Session events remain coarser:
only a completed assistant response is model-visible, while aborted steps and
turns record their terminal boundary without serializing `AbortSignal.reason`.
`aborted` means a live process observed cooperative cancellation;
`interrupted` is reserved for durable boundaries synthesized during cold-start
repair when the prior process disappeared without closing its turn.

A failed model finish may carry the canonical
`context_window_exceeded` code. Provider packages assign it conservatively;
the shared collector turns it into the provider-neutral overflow error used by
policy.

A completed finish may include normalized input/output token usage. The agent
loop commits that sample with the assistant event, exact input-surface
sequences, model identity, and tool-schema snapshot. Usage is log-only and does
not change message projection.

`compaction/summary` is the sole surface-transforming checkpoint. It records
summary text, summarizer identity, and the exact current surface sequence prefix
it shadows. The source events remain in the log; consumers derive the shorter
model surface by applying the checkpoint.

`context-budget/decision` is log-only. It records whether a pressure or
overflow action compacted, made no progress, or failed. A compacted outcome
must reference an earlier summary event; projection rejects invented
provenance.

`command/run` and `command/done` are standalone, log-only control-plane
boundaries. They record the exact parsed command suffix and its closed result;
an optional `sourceSequence` links output such as manual compaction to the
authoritative event that produced it. Commands are never projected as model
messages.
