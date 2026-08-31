# `@deepseek-cordis/runtime-cordis`

Cordis lifecycle adapter for the provider-neutral harness capabilities.

This package publishes session stores, tool registries, model adapters,
approval services, sandbox providers, a command registry, an optional session
compactor, optional token meter, and a stable agent-loop facade
as typed Cordis services. Tool and command registration and loop
connection are Cordis-owned effects, so withdrawing their plugin fibers
reclaims the underlying capability registration or connection.

Command definitions require the registry coeffect. They remain pending while
it is absent, register against a replacement provider when it appears, and
withdraw their exact registration before that provider is disposed.

Approval and sandbox are independent required coeffects of the loop plugin.
Withdrawing or replacing either provider drains the loop first and reconnects
the same facade after the replacement activates. Default provider plugins fail
closed; they exist to make unattended compositions explicit, not to grant or
simulate isolation.

It also re-exports the public context, fiber, plugin, and pinned fiber-state
vocabulary under `Runtime*` names. This gives `app-boot` a narrow lifecycle seam
without adding a second direct Cordis import or duplicating Cordis abstractions.

Only this production package imports `cordis`. It does not implement agent
behavior, load configuration, reconcile manifests, or restore failed
replacements; those responsibilities remain in the capability packages and
the later application-boot layer.

## TypeScript compatibility exception

The declarations published with exactly pinned `cordis@4.0.0-rc.8` contain
extensionless ESM exports and an ambient `const enum`. Consequently this
package's build and test configurations use `moduleResolution: "Bundler"` and
disable `verbatimModuleSyntax`. The repository's stricter shared settings stay
enabled for every provider-neutral package. Re-test and remove these overrides
when Cordis is upgraded.

See [`src/README.md`](src/README.md) for the lifecycle walkthrough.
