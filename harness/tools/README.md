# Tools

`@deepseek-cordis/tools` defines the tool registry contract and provides an
in-memory implementation.

A registration returns an idempotent disposer. Schemas, handler inputs, and
successful outputs cross the boundary as immutable snapshots. Missing tools and
handler failures return explicit failed executions so an agent loop can record
and show them to the model instead of losing the turn.

Definitions are a safety-discriminated union. A `risk: none` tool has a local
handler. A filesystem, shell, browser, or external tool has no local handler;
it declares a one-shot approval reason, sandbox profile, and required
enforcement strength. The registry snapshots that declaration at registration,
then requires call identity, approval, sandbox, and a synchronous durable audit
sink before consequential execution. Only `allowed-once` proceeds. The sandbox
provider owns the body through a one-call lease, and the registry always
disposes the lease. Missing, throwing, malformed, partial, or unauditable
providers fail closed.

Local handlers receive only their immutable arguments and optional turn signal;
the registry does not leak approval, sandbox, call identity, or audit
capabilities into handler options.

Execution receives the active turn's optional `AbortSignal`. Cooperative tool
handlers can stop pending work, and the registry rethrows cancellation instead
of converting it into an ordinary handler failure. The agent loop remains the
single owner of conservative cancellation results and aborted turn closure.
