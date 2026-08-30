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

`compaction/summary` is the sole surface-transforming checkpoint. It records
summary text, summarizer identity, and the exact current surface sequence prefix
it shadows. The source events remain in the log; consumers derive the shorter
model surface by applying the checkpoint.
