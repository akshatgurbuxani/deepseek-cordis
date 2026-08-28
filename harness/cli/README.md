# `@deepseek-cordis/cli`

First runnable production composition for the harness.

The CLI builds a complete `AppBoot` manifest containing an in-memory traced
session store, tool registry, calculator registration, replay or OpenRouter
model, and stable agent loop. It runs one turn, prints the final answer, and
always reconciles to an empty manifest in `finally` so every fiber,
registration, service, and connection is withdrawn before exit.

Replay mode is deterministic and needs no credential:

```sh
npm run cli:replay -- "add 17 and 25"
```

Live mode reads `.env` through Node's built-in environment-file support:

```sh
cp .env.example .env
# edit OPENROUTER_API_KEY, then:
npm run cli -- "add 17 and 25"
```

`OPENROUTER_MODEL` defaults to `openrouter/free`. Traces contain normalized
model requests and responses, session events, router diagnostics, and runtime
fiber transitions. API keys and authorization headers never enter traced
objects.

This command is deliberately one-shot. Interactive sessions, persistence,
streaming, cancellation, and provider replacement during a running turn remain
future work.
