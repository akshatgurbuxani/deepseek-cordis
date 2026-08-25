# `@deepseek-cordis/runtime-cordis`

Cordis lifecycle adapter for the provider-neutral harness capabilities.

This package publishes session stores, tool registries, model adapters, and a
stable agent-loop facade as typed Cordis services. Tool registration and loop
connection are Cordis-owned effects, so withdrawing their plugin fibers
reclaims the underlying capability registration or connection.

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
