# `@deepseek-cordis/context-budget`

Automatic pressure and canonical context-overflow policy for `AgentLoop`.

The policy measures the exact derived request surface before each step. It acts
only when the selected adapter advertises a context window and the versioned
heuristic measurement reaches the configured ratio. Recognized provider
overflow errors can trigger one bounded recovery even without capacity
metadata. A retry is authorized only when compaction committed a new summary
checkpoint; otherwise the original model error remains authoritative.

Every attempted policy action appends a log-only `context-budget/decision`
event containing the trigger, model, measurement, optional capacity and
threshold, outcome, and committed summary sequence or safe failure message.
Cancellation remains control flow and is never collapsed into a policy failure.
