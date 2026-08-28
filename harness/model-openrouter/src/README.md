# How the OpenRouter adapter works

`OpenRouterModelAdapter` is a provider implementation of the neutral
`ModelAdapter` contract. It contains no Cordis, application-boot, CLI, session,
or tool-registry dependency.

Each projected harness message maps to the OpenAI-compatible chat wire format.
User and assistant text remain text messages. Assistant tool calls serialize
their immutable JSON arguments. Tool results become `tool` messages linked by
`tool_call_id`; failed local executions are represented as JSON error objects.
Harness tool schemas become function tools with JSON Schema parameters.

Requests use the non-streaming `/api/v1/chat/completions` endpoint. When tools
exist, tool choice is automatic and parallel tool calls are disabled because
the current `AgentLoop` executes calls in deterministic order. The harness
session ID is forwarded as OpenRouter's supported `session_id` field.

Responses are decoded defensively from `unknown`. A completion must contain a
first choice and message, followed by either non-empty tool calls or text. Tool
envelopes, function names, argument strings, parsed JSON values, and finite
numbers are validated before they cross into the harness. Returned values and
diagnostics are snapshotted and recursively frozen.

The adapter opts into router metadata and reports selected model, token counts,
and the metadata object without interpreting its additive fields. The API key
is retained in a private field and placed only in the Authorization header.
Neither request bodies nor diagnostic values contain it.

The endpoint and `fetch` are injectable. Required tests therefore use real
`Request`/`Response` semantics without network access. A live smoke test is
skipped unless both `OPENROUTER_LIVE_TEST=1` and `OPENROUTER_API_KEY` are set.
