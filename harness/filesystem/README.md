# `@deepseek-cordis/filesystem`

Provider-neutral filesystem operations and mutation policy.

The contract exposes opaque resolved targets, bounded text reads, directory
listings and recursive discovery, stat, version-guarded write, exact edit,
multi-replacement patch preview/publication, move, and delete.
`FileObservationPolicy` is session-scoped: write requires a prior stat/read
(including observed absence), edits and delete require prior content
observation, and move additionally requires its destination to have been
confirmed absent. Providers report the stable `FS_*` error taxonomy exported
by this package.

This package knows neither Node paths nor model tools. Concrete providers own
confinement and atomicity; model-facing adapters own schemas and approval.
