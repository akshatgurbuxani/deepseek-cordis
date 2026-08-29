# `@deepseek-cordis/session-file`

Versioned, file-backed implementation of the provider-neutral `SessionStore`.

Each session is stored as one JSON document named by the SHA-256 digest of its
ID. Every append writes the complete candidate document to an exclusive
same-directory temporary file, fsyncs it, and atomically renames it over the
committed file. The in-memory event list advances only after that commit point,
so a failed write leaves both memory and the previous file unchanged.

Schema V1 stores `schemaVersion`, `id`, and the complete immutable event list.
Versionless V0 documents with `id` and `events` are validated and rewritten as
V1 during startup. Unknown versions, malformed JSON, invalid event fields,
sequence gaps, and filename/ID mismatches fail explicitly and are never
overwritten.

The current provider assumes one active writer per directory. Atomic replacement
protects against torn process writes; cross-process locking and merge semantics
are deliberately not claimed. Temporary files left by process death are ignored
on restart.
