# How durable sessions work

`FileSessionStore` creates its directory and scans only canonical
`session-<sha256>.json` files. A digest filename prevents session IDs from
escaping the configured directory. The ID inside each document must reproduce
the same filename, making accidental renames or copied contents visible.

Startup parses documents from `unknown`, validates schema version, event
envelopes, contiguous sequences, discriminated event fields, tool calls, and
finite JSON values, then snapshots every event. It inspects only the suffix
after the last closed turn. A non-empty suffix must describe one unambiguous
open turn: turn and step IDs must agree, execution events must stay within the
open step, and tool-call/result transitions must be unique and ordered.

For a valid interrupted suffix, `interruptedTurnClosers()` derives an append-only
repair. It emits failed results for pending calls in assistant-request order,
using an unknown-outcome message after a recorded `tool/call` and a not-started
message otherwise. It then emits an interrupted `step/end` when needed and an
interrupted `turn/end`. Already committed events are never rewritten or
discarded, and closed documents produce no repair.

Migration and repair are combined into one V1 candidate document and one writer
call. Only after that call succeeds does the store publish the repaired
`FileSession`; reopening sees a closed turn and performs no second write. This
is a cold-only boundary: the store owns no live agent loop while its constructor
scans files, and it does not attempt partial-turn resume. The store publishes no
session until the full scan succeeds.

`FileSession.append()` snapshots the next sequenced event and builds a candidate
event list without mutating live memory. Its persistence callback encodes a V1
document and calls the configured writer. Only a successful return pushes the
event into memory. Injecting a writer lets deterministic tests prove that a
failure before commit leaves the session and its previous document unchanged.

The production writer creates a unique temporary file in the destination
directory, writes with owner-only permissions, fsyncs and closes it, then uses
rename as the atomic commit point. It removes uncommitted temporary files on
failure. Directory fsync is best-effort because some platforms reject it; no
error is reported after a rename has already committed.

Versionless documents are the sole supported V0 shape. They pass through the
same event validation and are immediately rewritten as V1. Future or unknown
versions stop startup without modification. New migrations must be explicit,
deterministic, tested from fixtures, and advance one version at a time.
