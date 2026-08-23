# Session

`@deepseek-cordis/session` defines the session and store contracts and provides
an in-memory reference implementation.

Every appended event receives the next sequence number and is snapshotted
before storage. `projectMessages()` derives only the history visible to a model;
turn and step bookkeeping remains durable without becoming prompt content.
There is no second mutable transcript.
