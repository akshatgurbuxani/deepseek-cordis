# `@deepseek-cordis/command-session`

Plugin-ready session command definitions. `/inspect` reports durable event,
turn, projection, and compaction state without contacting the model.
`/compact [retain-turns]` invokes the existing provenance-preserving compactor and links
its command result to the authoritative summary event.
