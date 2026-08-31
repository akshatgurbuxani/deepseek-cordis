# How the first production command works

`runCli()` separates command orchestration from the process entry point. Tests
inject arguments, environment values, `fetch`, tracing, output, session ID,
text-delta observation, and cancellation; `main.ts` supplies the real process
values, streams text to stdout, and converts failure or cancellation into the
appropriate non-zero exit code.

Argument parsing selects an optional schema-V1 JSON profile, deterministic
replay override with `--replay`, and interactive mode. Profile validation and
path resolution complete before runtime construction; explicit launch
environment values overlay the immutable profile. Replay extracts two numeric
operands and scripts one tool call followed by a final answer. Live mode
requires `OPENROUTER_API_KEY`, defaults `OPENROUTER_MODEL` to
`openrouter/free`, and passes optional app-attribution fields to the provider
adapter.

The command creates an `AppBoot` and installs lifecycle tracing before building
its profile-derived manifest. Exact tool and prompt entries use stable IDs and
profile-owned enablement. The manifest deliberately lists the agent loop before
its providers, demonstrating that Cordis keeps it pending until the traced
session store, tool registry, selected tools, and traced model are available. A
required prompt registry receives only the profile-selected identity, persona,
and tool-aware workspace effects; the loop remains pending until the registry
is active. When selected, the workspace adapter keeps observation/version
state for the mounted runtime and executes both the generalized family and the
compatible Feature 14 create-only schema through provider-owned leases.

Before reconciliation, the command selects the in-memory store or constructs
the file provider configured by `HARNESS_SESSION_DIR`. Construction validates
and durably closes any unambiguous interrupted tail before the store becomes a
Cordis capability. Its tracing store decorates that provider and caches
wrappers, preserving the identity rule required by the agent loop. After
reconciliation, it creates the configured session or resumes an existing
`HARNESS_SESSION_ID` with a new turn, runs it, traces the result, and prints its
final content. The process entry point maps `SIGINT` to a runtime-only
`{ kind: 'user' }` abort cause and exits 130 after durable turn closure.
`finally` always reconciles an empty manifest before removing the lifecycle
listener. Success, model failure, cancellation, configuration failure after
mounting, and tool failure therefore share the same cleanup path.

Tracing wraps public session and model contracts. It records session events,
normalized requests, stream chunks and responses, OpenRouter diagnostics, and
fiber state changes. It never receives the provider options, API key, HTTP
headers, or raw environment object.
