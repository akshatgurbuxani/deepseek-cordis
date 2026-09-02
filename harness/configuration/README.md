# `@deepseek-cordis/configuration`

Versioned, fail-loud application profiles for the production harness.

The package validates unknown input, rejects unknown or incompatible fields,
applies explicit defaults, and returns one detached recursively immutable
`HarnessProfile`. It owns deployment choices—not model, session, tool, prompt,
approval, sandbox, or Cordis behavior.

Schema V1 selects the model provider and optional exact capacity, workspace
root and file bound, memory or file persistence, exact visible tool IDs,
identity/persona/workspace prompt sections, ask-or-deny approval default, and
context-pressure policy. Its `process` section selects a local or Docker
backend, executable names, default and maximum timeouts, per-stream output
bytes, and termination grace. Docker profiles additionally require a local
image and select memory, process-count, and temporary-filesystem bounds.
OpenRouter model profiles expand to an explicit bounded retry policy and
provider-routing policy. Retry count and delays have hard schema ceilings;
routing fixes fallback, parameter-support, data-collection, and sort behavior
instead of inheriting mutable remote defaults.
Workspace-instruction discovery is configured separately
from authored persona text: it selects the applicable subdirectory, candidate and
local-overlay names, project markers, and explicit source/aggregate byte caps.
Paths remain unresolved strings; the launcher resolves
relative paths against the profile file rather than the process by accident.

Profiles never contain credentials. Provider secrets remain launch-environment
inputs and are never copied into a validated profile, trace, or manifest.
