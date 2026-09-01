# `@deepseek-cordis/commands`

Provider-neutral human slash-command registry. Commands run directly against a
session and never become model messages. Registrations are immutable,
discoverable, and reversibly owned. Syntax or lookup misses append nothing.

An admitted invocation appends `command/run` before its handler and
`command/done` after settlement. Results are direct adapter output and remain
log-only. Cancellation and thrown handlers settle as explicit command errors.
Definitions may select admission-only cancellation for a transaction that must
settle once its commit begins; cancellation is still checked before admission,
while the default cooperative policy converts an in-flight abort to an error.
Successful results may cite an authoritative, earlier non-command event; the
registry rejects invented or recursive provenance before committing `done`.
Per-session admission excludes open model turns and concurrent command handlers,
so the registry cannot create overlapping lifecycle boundaries.
