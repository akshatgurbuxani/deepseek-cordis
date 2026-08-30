# How token measurement works

Each call derives a fresh surface from the immutable session log, estimates
every visible node independently, and snapshots its event sequence with its
cost. Tool schemas are priced separately because they contribute to every model
request without becoming session messages. The result is O(surface), frozen,
and tied to `session.events.length`; it does not mutate as later events arrive.

Compaction can make `surfaceTokens` fall even though `logRevision` rises. This
is expected: durable log order and current surface position are different
dimensions.
