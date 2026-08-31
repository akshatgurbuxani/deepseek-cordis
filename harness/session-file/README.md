# `@deepseek-cordis/session-file`

Versioned, file-backed implementation of the provider-neutral `SessionStore`.

Each session is stored as one JSON document named by the SHA-256 digest of its
ID. Every append writes the complete candidate document to an exclusive
same-directory temporary file, fsyncs it, and atomically renames it over the
committed file. The in-memory event list advances only after that commit point,
so a failed write leaves both memory and the previous file unchanged.

Schema V6 stores `schemaVersion`, `id`, and the complete immutable event list,
including provenance-bearing compaction checkpoints and context-budget
decisions. It also permits validated provider-usage anchors on assistant events
and log-only approval/sandbox and command lifecycle events. Versionless V0 plus
V1 through V5 documents are rewritten as V6 during startup. Unknown versions,
malformed JSON, invalid event fields,
sequence gaps, and filename/ID mismatches fail explicitly and are never
overwritten.

Startup also repairs one structurally valid trailing turn that lacks its
terminal boundary. It preserves every committed event, appends a failed
`tool/result` for each unanswered assistant tool call, closes an open step as
`interrupted`, and closes the turn as `interrupted`. A recorded `tool/call`
means execution may have produced an irreversible effect, so its synthetic
result says the outcome is unknown; a requested call without `tool/call` is
recorded as not started. The store never resumes partial execution or invents a
successful result.

A standalone `command/run` without `command/done` is repaired separately as an
interrupted command. Commands cannot appear inside turns, matching IDs and names
are mandatory, and optional result provenance must identify an earlier
non-command event. Command output never enters the model surface.

Migration and repair share one atomic replacement and occur before any loaded
session is published. Reopening the repaired file is therefore idempotent. An
ambiguous tail is corruption rather than repair input, and a failed repair
write leaves the original document unchanged and unpublished.

Compaction checkpoint fields and their exact surface-prefix relationship are
validated before load or append. A checkpoint uses the same atomic append path
as every other event, so its summary and provenance cannot commit separately.
Compacted budget decisions must reference an earlier checkpoint and cannot
smuggle the new event vocabulary into a legacy schema.
Usage anchors cite the exact pre-response surface and preserve their tool
schemas atomically with the assistant event.
Approval outcomes use a closed vocabulary, sandbox preparation records provider
identity and enforcement strength, and neither event family enters model
projection. Legacy documents cannot smuggle these V5 events into older schemas.

The current provider assumes one active writer per directory. Atomic replacement
protects against torn process writes; cross-process locking and merge semantics
are deliberately not claimed. Temporary files left by process death are ignored
on restart.
