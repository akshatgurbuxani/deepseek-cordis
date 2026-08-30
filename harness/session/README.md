# Session

`@deepseek-cordis/session` defines the session and store contracts and provides
an in-memory reference implementation.

Every appended event receives the next sequence number and is snapshotted
before storage. `projectMessages()` derives only the history visible to a model;
turn and step bookkeeping remains durable without becoming prompt content.
There is no second mutable transcript.

Failed and aborted boundaries are bookkeeping rather than model messages.
Streaming text is appended as `assistant/message` only after the model's
completed terminal finish, so cancellation cannot leave partial assistant text
in resumed history.

Durable storage is provided separately by `@deepseek-cordis/session-file`
behind the same contracts. Both providers use the exported pure
`projectSessionMessages()` function, so persisted and ephemeral histories
produce the same model-visible transcript.
