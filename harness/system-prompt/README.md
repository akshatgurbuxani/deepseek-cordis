# `@deepseek-cordis/system-prompt`

Provider-neutral system-prompt assembly.

Contributors register named, ordered static or per-step sections. A section
registered for a session scope shadows the same global name only for that
session. Assembly evaluates contributors once against the exact request IDs,
tool schemas, and cancellation signal, drops empty text, and returns one
immutable prompt joined with blank lines.

The package does not import Cordis, model adapters, the agent loop, or concrete
tools. Cordis lifecycle ownership lives in `runtime-cordis`; wire formatting
lives in model adapters.

Prompt text is request data, not a secret store. The assembled value is sent to
the model and may be traced or persisted with assistant usage so an exact
provider-usage anchor can be reconstructed. Contributors must never place API
keys, credentials, or other secrets in a section.
