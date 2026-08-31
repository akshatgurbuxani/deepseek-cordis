# `@deepseek-cordis/model-openrouter`

Provider-neutral OpenRouter implementation of `ModelAdapter`.

The adapter maps an optional immutable system prompt, harness history, and tool
schemas to OpenRouter's chat-completions API. The prompt is emitted as the
first `system` message and never inserted into session history. Its canonical model seam consumes server-sent events,
emits text deltas, assembles fragmented local tool calls, and terminates with a
normalized finish. `complete()` remains available as a compatibility collector.
Both paths report usage plus additive router metadata through a diagnostics
callback. The streaming finish also carries validated prompt/completion usage
through the provider-neutral boundary so sessions can anchor pressure.
An optional configured `contextWindow` exposes exact capacity to policy.
Without it, `resolveInfo()` queries `/api/v1/models`, selects the requested ID
or canonical slug, validates `context_length`, and caches the result.
Recognized HTTP or streamed context-limit failures normalize to
`ModelContextOverflowError`; status alone is insufficient, so an unrelated 413
remains an ordinary HTTP failure.
Credentials exist only in a private field and the HTTP authorization header;
they never enter model requests, session events, diagnostics, or errors.

The exact request and streaming shapes are verified against current official
OpenRouter docs.
The endpoint and `fetch` implementation are injectable for deterministic tests.
Reasoning-detail preservation, server tools, and provider routing policy are
intentionally deferred.

Current primary references:

- [OpenRouter API quickstart](https://openrouter.ai/docs/quickstart)
- [local tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- [router metadata](https://openrouter.ai/docs/guides/features/router-metadata)
- [`openrouter/free`](https://openrouter.ai/docs/guides/routing/routers/free-router)
- [models and context lengths](https://openrouter.ai/docs/api/api-reference/models/get-models)
