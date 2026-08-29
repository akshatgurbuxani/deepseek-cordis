# Session

`@deepseek-cordis/session` defines the session and store contracts and provides
an in-memory reference implementation.

Every appended event receives the next sequence number and is snapshotted
before storage. `projectMessages()` derives only the history visible to a model;
turn and step bookkeeping remains durable without becoming prompt content.
There is no second mutable transcript.

Durable storage is provided separately by `@deepseek-cordis/session-file`
behind the same contracts. Both providers use the exported pure
`projectSessionMessages()` function, so persisted and ephemeral histories
produce the same model-visible transcript.
