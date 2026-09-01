# Command source boundary

The registry owns syntax, discovery, immutable registration, direct dispatch,
and lifecycle pairing. Individual commands own their input grammar and domain
effects. Interactive adapters own prompting, rendering, and deciding whether a
non-command line should be sent to the model.

The registry also owns cancellation settlement. Cooperative commands remain the
default; admission-only is reserved for atomic effects whose rollback/commit
must finish after admission.
