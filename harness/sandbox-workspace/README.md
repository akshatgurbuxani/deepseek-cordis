# `@deepseek-cordis/sandbox-workspace`

Narrow host-mediated provider for `create_workspace_file`. The model supplies
only a relative path and UTF-8 content; the provider validates the exact
request, rejects traversal and symlinked parents, and owns the file effect.
Creation is no-overwrite and namespace-atomic through an exclusive hard link
from a fully written same-directory temporary file.

The lease reports `partial` enforcement honestly. Node's portable path APIs do
not expose an `openat`-style directory capability, so another host process can
race a validated parent path. This is still a real policy boundary for the
declarative operation—no model code or host-local handler executes—but it is
not general process isolation and does not claim a race-free `full` boundary.
