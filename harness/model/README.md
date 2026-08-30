# Model

`@deepseek-cordis/model` defines the provider-neutral streaming contract.
Every adapter yields text deltas followed by exactly one terminal finish:
completed with a normalized response, failed with a safe error message, or
aborted. Provider packages translate their wire formats at this boundary.

Adapters may advertise an exact `contextWindow`. Capacity is provider metadata,
not inferred from a pressure estimate. A coded stream failure becomes
`ModelContextOverflowError`, allowing policy to distinguish context pressure
from unrelated provider failures without parsing arbitrary errors in the loop.

`completeModel()` is the shared collector used by the agent loop and tests. It
forwards text deltas to an optional observer, rejects malformed streams, and
returns only a completed response. Partial text is live output, not durable
model history; the agent loop commits the final response after the terminal
finish.

`@deepseek-cordis/model/testing` exports the deterministic replay adapter used
by harness tests. It snapshots its response script and every received request,
emits deterministic stream chunks, and honors an explicit abort signal.
