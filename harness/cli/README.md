# `@deepseek-cordis/cli`

First runnable production composition for the harness.

The CLI builds a complete `AppBoot` manifest containing a traced session store,
tool registry, harmless calculator, consequential workspace filesystem family,
channel/headless approval, concrete workspace provider, replay or OpenRouter
model, scoped system-prompt registry, and stable agent loop. It runs
one turn, prints the final answer, and always reconciles to
an empty manifest in `finally` so every fiber, registration, service, and
connection is withdrawn before exit.

Replay mode is deterministic and needs no credential:

```sh
npm run cli:replay -- "add 17 and 25"
```

Select a validated schema-V1 JSON profile with `--profile` or
`HARNESS_PROFILE`:

```sh
cp harness/cli/profile.example.json ./harness-profile.json
npm run cli -- --profile ./harness-profile.json "inspect the workspace"
```

Profiles select the model provider and optional exact capacity, workspace root
and size bound, memory or file persistence, exact visible tool IDs, prompt
identity/persona/workspace guidance, ask-or-deny approval default, and context
pressure settings. Omitted sections receive explicit defaults. Unknown fields,
unknown/duplicate tools, invalid bounds, incompatible provider fields, invalid
JSON, and unsupported schema versions fail before `AppBoot` exists.
Recognized tool IDs are `add`, `workspace.create`, `workspace.read`,
`workspace.list`, `workspace.stat`, `workspace.write`, and `workspace.edit`.
Selections normalize to that stable presentation order.

Relative workspace and persistence paths are resolved against the profile
file. `--replay` overrides its model provider; `OPENROUTER_MODEL`, context-window
variables, `HARNESS_WORKSPACE_ROOT`, and `HARNESS_SESSION_DIR` are launch-local
overlays and take precedence. A profile is frozen for one process invocation;
interactive turns never observe a partially reloaded policy.

`approval.default: "ask"` uses the active interaction channel and fails closed
when no channel exists. `"deny"` never invokes the channel and durably records
policy rejection. Profiles are not a credential store: `OPENROUTER_API_KEY`
remains environment-only, and profile contents are never copied wholesale into
traces.

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

Add `--interactive` for a persistent multi-turn process:

```sh
npm run cli:replay -- --interactive
```

Interactive input that begins with `/` is dispatched directly, never sent to
the model. `/inspect` reports durable session state, `/compact [retain-turns]`
uses the authoritative compactor, `/help` lists live registrations, and `/exit`
records its command boundary before clean shutdown. Syntax and lookup misses
append nothing. Replay mode derives a fresh deterministic calculator exchange
for every turn; live mode reuses the configured OpenRouter adapter.

The interactive channel also owns the one-shot approval prompt. Yes grants the
exact request once, any other answer rejects it, EOF cancels it, and prompt
failure is unavailable. The provider-neutral approval service never reads a
terminal itself, so a future UI can supply the same closed answer contract.
The prompt includes the immutable exact tool arguments before asking for a
one-shot grant.

`create_workspace_file` creates one new UTF-8 file without overwriting. Its
root defaults to the launch working directory and can be selected explicitly:

```sh
HARNESS_WORKSPACE_ROOT=/absolute/workspace npm run cli -- --interactive
```

The provider rejects absolute/traversing paths, symlinked parents, missing
parents, existing targets, and content above 1 MiB. It reports `partial`
enforcement honestly: publication is atomic and provider-owned, but portable
Node path APIs cannot eliminate a hostile concurrent parent-swap race.

The generalized family also exposes bounded `read_workspace_file`,
`list_workspace_directory`, and `stat_workspace_path`, plus guarded
`write_workspace_file` and `edit_workspace_file`. A write requires the same
session to stat or read the target first; an edit requires a content read and
exactly one `oldText` match. Opaque versions reject stale mutations. Directory
responses are capped at 200 entries and text operations at 1 MiB. These tools
use the same exact-argument approval and durable audit path as create.

By default, every request receives a deterministic system prompt: the harness
identity followed by workspace guidance derived from the exact visible
filesystem tool set. The guidance contains no absolute host path. Prompt
sections are Cordis effects, so provider replacement drains the loop and
withdraws registrations before reconnection. Prompt cost participates in
proactive context pressure and the exact rendered text accompanies successful
provider-usage anchors.

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

Profile hot reload, cross-process writer locking, parallel tool execution, and
provider replacement during a running turn remain future work.
