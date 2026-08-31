# `@deepseek-cordis/app-boot`

Declarative application composition above the Cordis lifecycle adapter.

`AppBoot` reconciles a complete desired manifest by stable entry ID and explicit
revision. It validates ownership, preloads changed plugins, preserves unchanged
fibers, applies additions/removals/replacements in ownership order, and restores
the last-known-good plugin graph if candidate activation fails.

The package imports Cordis lifecycle types only through
`@deepseek-cordis/runtime-cordis`. It does not parse configuration files, watch
modules, invalidate ESM caches, implement provider behavior, or promise to
restore arbitrary private state already released during a failed transition.

Because the adapter's public declarations expose types from the exactly pinned
Cordis package, this build and its test typecheck inherit the adapter's isolated
`moduleResolution: "Bundler"` and `verbatimModuleSyntax: false` compatibility
settings.

See [`src/README.md`](src/README.md) for the transaction walkthrough.
