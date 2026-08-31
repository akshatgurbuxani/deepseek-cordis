# `@deepseek-cordis/filesystem`

Provider-neutral filesystem operations and mutation policy.

The contract exposes opaque resolved targets, bounded text reads and directory
listings, stat, version-guarded write, and exact edit. `FileObservationPolicy`
is session-scoped: write requires a prior stat/read (including observed
absence), while edit requires prior content observation. Providers report the
stable `FS_*` error taxonomy exported by this package.

This package knows neither Node paths nor model tools. Concrete providers own
confinement and atomicity; model-facing adapters own schemas and approval.
