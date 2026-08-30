# `@deepseek-cordis/sandbox`

Provider-neutral boundary for consequential tool execution. The provider
prepares one exact call, reports `full` or `partial` enforcement, and returns a
lease that owns execution. The host never hands an unrestricted callback to a
provider and therefore cannot mistake an in-process wrapper for isolation.
Every lease has idempotent cleanup, which the registry runs after success,
failure, rejection after preflight, or cancellation.

`UnavailableToolSandbox` fails closed. Concrete filesystem, shell, browser, or
remote-execution backends belong in provider packages and must document what
their enforcement fact covers.
