# How durable sessions work

`FileSessionStore` creates its directory and scans only canonical
`session-<sha256>.json` files. A digest filename prevents session IDs from
escaping the configured directory. The ID inside each document must reproduce
the same filename, making accidental renames or copied contents visible.

Startup parses documents from `unknown`, validates schema version, event
envelopes, contiguous sequences, discriminated event fields, tool calls, and
finite JSON values, then snapshots every event. The store publishes no session
until the full scan succeeds.

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
