# `@deepseek-cordis/model-openrouter`

Provider-neutral OpenRouter implementation of `ModelAdapter`.

The adapter maps immutable harness messages and tool schemas to OpenRouter's
non-streaming chat-completions API, normalizes text and local tool calls, and
reports usage plus additive router metadata through a diagnostics callback.
Credentials exist only in a private field and the HTTP authorization header;
they never enter model requests, session events, diagnostics, or errors.

The exact request shape is verified against current official OpenRouter docs.
The endpoint and `fetch` implementation are injectable for deterministic tests.
Streaming, reasoning-detail preservation, server tools, and provider routing
policy are intentionally deferred.

Current primary references:

- [OpenRouter API quickstart](https://openrouter.ai/docs/quickstart)
- [local tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- [router metadata](https://openrouter.ai/docs/guides/features/router-metadata)
- [`openrouter/free`](https://openrouter.ai/docs/guides/routing/routers/free-router)
