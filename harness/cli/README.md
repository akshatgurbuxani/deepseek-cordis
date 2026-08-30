# `@deepseek-cordis/cli`

First runnable production composition for the harness.

The CLI builds a complete `AppBoot` manifest containing a traced session store,
tool registry, harmless calculator registration, fail-closed approval and
sandbox providers, replay or OpenRouter model, and stable agent loop. It runs
one turn, prints the final answer, and always reconciles to
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

The second command resumes `demo` and records turn two. If the previous process
disappeared during a turn, file-store construction first durably repairs that
turn as interrupted and balances any unanswered tool calls. The command then
starts a new turn; it never resumes partial model or tool execution.

Set exact provider capacity to enable proactive pressure compaction:

```sh
HARNESS_CONTEXT_WINDOW=128000 npm run cli -- "continue the task"
```

OpenRouter capacity is resolved from the official model catalog and cached for
the adapter lifetime. `HARNESS_CONTEXT_WINDOW` or
`OPENROUTER_CONTEXT_WINDOW` can override it explicitly. The
CLI measures the persisted surface and live calculator schema before each
request, compacts at 80% pressure, and permits one retry after a canonical
provider overflow only when a new checkpoint commits. Replay mode uses a
deterministic summary response; live mode uses the configured model through the
same adapter. Decisions and checkpoint provenance remain in the session file.
Successful OpenRouter prompt usage is stored with its exact request anchor, so
later turns and restarts use a provider baseline plus explicit heuristic deltas.
No capacity or token count is guessed from a model name.
Traces expose successful `model/info` resolution and safe `model/info-error`
failures without including credentials.

Interactive commands (including manual inspect/compact), cross-process writer
locking, parallel tool execution, and provider replacement during a running
turn remain future work.
