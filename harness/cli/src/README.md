# How the first production command works

`runCli()` separates command orchestration from the process entry point. Tests
inject arguments, environment values, `fetch`, tracing, output, and session ID;
`main.ts` supplies the real process values and converts rejection into a
non-zero exit code.

Argument parsing selects deterministic replay mode with `--replay`; otherwise
it selects OpenRouter. Replay extracts two numeric operands and scripts one
tool call followed by a final answer. Live mode requires
`OPENROUTER_API_KEY`, defaults `OPENROUTER_MODEL` to `openrouter/free`, and
passes optional app-attribution fields to the provider adapter.

The command creates an `AppBoot` and installs lifecycle tracing before building
its manifest. The manifest deliberately lists the agent loop before its
providers, demonstrating that Cordis keeps it pending until the traced session
store, tool registry, calculator, and traced model are available.

After reconciliation, the command creates one session, runs one turn, traces
the result, and prints its final content. `finally` always reconciles an empty
manifest before removing the lifecycle listener. Success, model failure,
configuration failure after mounting, and tool failure therefore share the
same cleanup path.

Tracing wraps public session and model contracts. It records session events,
normalized requests and responses, OpenRouter diagnostics, and fiber state
changes. It never receives the provider options, API key, HTTP headers, or raw
environment object.
