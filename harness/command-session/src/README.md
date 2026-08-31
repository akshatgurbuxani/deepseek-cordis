# Session command source boundary

Inspection is a pure projection over the session log. Compaction delegates to
`SessionCompactor`; this package does not duplicate selection, concurrency, or
provenance rules. Command lifecycle remains owned by the command registry.
