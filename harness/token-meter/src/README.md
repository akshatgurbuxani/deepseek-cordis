# How token measurement works

Each call derives a fresh surface from the immutable session log, estimates
every visible node independently, and snapshots its event sequence with its
cost. Tool schemas and the system prompt are priced separately because they
contribute to every model request without becoming session messages. The result is O(surface), frozen,
and tied to `session.events.length`; it does not mutate as later events arrive.

Compaction can make `surfaceTokens` fall even though `logRevision` rises. This
is expected: durable log order and current surface position are different
dimensions.

For a provider-anchored measurement, the newest durable usage sample supplies
the exact input baseline. Its cited surface is re-derived at the assistant
event boundary and stored tool schemas/system prompt are repriced with the current estimator.
The current-minus-anchor heuristic delta is applied to the provider count.
Because source events survive compaction, an anchor remains usable after its
visible nodes become a summary checkpoint.
When a caller supplies a model identity, only a sample from that same adapter
route is eligible; replacement falls back to the full heuristic until the new
route reports usage.
