# How context-budget policy works

`beforeStep()` combines adapter-owned capacity with one immutable token-meter
snapshot. Below pressure it writes nothing. At or above pressure it asks the
compactor to reduce a closed-turn prefix at the between-step maintenance
boundary and records the result.

Capacity resolution may be asynchronous. Cancellation remains authoritative;
other lookup failures mean capacity is unavailable and skip proactive policy
without preventing the model call.

`recoverModelError()` accepts only `ModelContextOverflowError`, enforces the
per-turn retry bound, and runs the same compactor without requiring capacity
metadata. The agent loop retries only after a new summary sequence commits.
Noncanonical errors, exhausted retries, no useful range, and compaction failure
all preserve the original provider error. An aborted signal always wins.
