# How compaction works

The compactor derives the current surface, identifies the oldest closed turns,
and selects a prefix that leaves `retainTurns` untouched. Prior summary nodes
may be selected later, so their event sequence becomes part of the next
checkpoint's `shadowedSequences`; this forms an auditable provenance chain back
to the original events.

The summary request is snapshotted before crossing the adapter boundary. After
the adapter resolves, the compactor checks cancellation, rejects empty output,
requires the session to remain between turns, and compares the current surface
prefix with the selected sequence list. Only then does it append the single
checkpoint event. A file-backed session therefore commits the complete
replacement atomically through its existing append path.
