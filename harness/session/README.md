# Session

`@deepseek-cordis/session` defines the session and store contracts and provides
an in-memory reference implementation.

Every appended event receives the next sequence number and is snapshotted
before storage. `projectMessages()` derives only the history visible to a model;
turn and step bookkeeping remains durable without becoming prompt content.
There is no second mutable transcript.

Failed, aborted, and interrupted boundaries are bookkeeping rather than model
messages. A file provider may project synthetic failed tool results from an
interrupted turn so a resumed provider transcript never contains an unanswered
assistant tool call. Those results conservatively distinguish calls known to
have started, whose outcome is unknown, from calls that never started.
Streaming text is appended as `assistant/message` only after the model's
completed terminal finish, so cancellation cannot leave partial assistant text
in resumed history.

Durable storage is provided separately by `@deepseek-cordis/session-file`
behind the same contracts. Both providers use the exported pure
`projectSessionMessages()` function, so persisted and ephemeral histories
produce the same model-visible transcript.

`deriveSessionSurface()` retains each visible message's event sequence and
applies `compaction/summary` only when its `shadowedSequences` exactly match the
current surface prefix. It replaces that prefix with one user-role checkpoint
node while preserving every source event. Invalid or reordered provenance is a
projection error and is rejected before either reference store commits it.
