# System-prompt source

`index.ts` owns registration, deterministic ordering, session-scoped
shadowing, dynamic assembly context, cancellation, and the default harness
identity section. Keep adapter wire formats and provider-specific guidance out
of this package. Treat every returned section as model-visible and potentially
persisted request data; secrets do not belong in prompt contributors.
