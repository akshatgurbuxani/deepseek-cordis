# `@deepseek-cordis/cli`

First runnable production composition for the harness.

The CLI builds a complete `AppBoot` manifest containing a traced session store,
tool registry, calculator registration, replay or OpenRouter model, and stable
agent loop. It runs one turn, prints the final answer, and always reconciles to
an empty manifest in `finally` so every fiber, registration, service, and
connection is withdrawn before exit.

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

The process entry point streams assistant text to stdout and passes one
turn-scoped signal through the loop. `Ctrl-C` cooperatively aborts model or tool
work, waits for the durable aborted boundary and Cordis cleanup, then exits with
status 130. Programmatic callers can inject the same signal and a text-delta
observer through `runCli()`.

Sessions remain ephemeral by default. Set `HARNESS_SESSION_DIR` to select the
file provider and `HARNESS_SESSION_ID` to give the history a stable identity:

```sh
HARNESS_SESSION_DIR=.sessions HARNESS_SESSION_ID=demo \
  npm run cli:replay -- "add 17 and 25"
HARNESS_SESSION_DIR=.sessions HARNESS_SESSION_ID=demo \
  npm run cli:replay -- "add 8 and 9"
```

The second command resumes `demo` and records turn two. Interactive input,
cross-process writer locking, parallel tool execution, and provider replacement
during a running turn remain future work.
