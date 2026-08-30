# How the OpenRouter adapter works

`OpenRouterModelAdapter` is a provider implementation of the neutral
`ModelAdapter` contract. It contains no Cordis, application-boot, CLI, session,
or tool-registry dependency.

Each projected harness message maps to the OpenAI-compatible chat wire format.
User and assistant text remain text messages. Assistant tool calls serialize
their immutable JSON arguments. Tool results become `tool` messages linked by
`tool_call_id`; failed local executions are represented as JSON error objects.
Harness tool schemas become function tools with JSON Schema parameters.

Requests use `/api/v1/chat/completions`. The canonical `stream()` path requests
server-sent events plus terminal usage, tolerates keepalive comments and network
chunk boundaries, emits normalized text deltas, and assembles indexed tool-call
fragments before its completed finish. `complete()` retains the original JSON
path unless a delta observer requests collection through the streaming seam.

`resolveInfo()` uses the official `/api/v1/models` catalog when no explicit
capacity override exists. It matches the configured ID or canonical slug,
accepts only a positive integer `context_length`, and caches a successful or
known-absent result. Metadata failure disables proactive pressure for that step
without preventing the provider request or canonical overflow recovery.

When tools exist, tool choice is automatic and parallel tool calls are disabled
because the current `AgentLoop` executes calls in deterministic order. The
harness session ID is forwarded as OpenRouter's supported `session_id` field.

Responses and SSE payloads are decoded defensively from `unknown`. A completion
must contain a choice followed by tool calls or text. Tool envelopes, fragment
indexes, function names, argument strings, parsed JSON values, and finite
numbers are validated before they cross into the harness. Returned chunks,
values, and diagnostics are snapshotted and recursively frozen.

The request signal is passed directly to `fetch`. An abort becomes the stream's
terminal `aborted` finish; network, HTTP, framing, and response failures become
terminal error finishes. This follows the model contract's data boundary while
the compatibility `complete()` method still throws its typed provider errors.

The adapter opts into router metadata and reports selected model, token counts,
and the metadata object without interpreting its additive fields. Valid
prompt/completion counts also enter the completed stream finish. The API key
is retained in a private field and placed only in the Authorization header.
Neither request bodies nor diagnostic values contain it.

The endpoint and `fetch` are injectable. Required tests therefore use real
`Request`/`Response` semantics without network access. A live smoke test is
skipped unless both `OPENROUTER_LIVE_TEST=1` and `OPENROUTER_API_KEY` are set.
