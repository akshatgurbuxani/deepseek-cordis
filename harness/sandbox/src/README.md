# Sandbox source boundary

`prepare()` must not perform the requested action. It returns a provider-owned
lease for one exact call and reports actual enforcement strength. `execute()`
performs the action inside that provider's isolation boundary; `dispose()` is
idempotent and releases all preparation resources whether execution runs,
fails, or is rejected after preflight.

There is intentionally no in-process pass-through provider. Such a provider
would be an execution wrapper, not a sandbox.
