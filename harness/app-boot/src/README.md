# How application boot reconciliation works

Each `ManifestEntry` has a stable `id`, an explicit `revision`, an optional
`parentId`, an optional enabled flag, an optional target runtime context, and an
async plugin loader. IDs preserve configuration identity. Revisions state when
code or relevant configuration changed. Parent relationships control effective
enablement and teardown order; Cordis service declarations still control actual
dependency activation.

`reconcile()` snapshots its input and serializes it behind earlier transactions.
Before loading code or touching live fibers, it rejects duplicate IDs, missing
parents, and ownership cycles. Disabled parents make their descendants
effectively disabled.

The host classifies mounted entries as removed, updated, added, or preserved.
It preloads all changed active plugins concurrently, so a loader or import error
leaves the exact current graph untouched. It then disposes removals from leaves
to roots, disposes replaced fibers, mounts additions and replacements from roots
to leaves, and awaits all mounted fibers. Cordis independently keeps consumers
pending or reactivates them as their declared services change.

If activation fails, the host disposes every candidate, remounts each retired
last-known-good plugin, waits for preserved and restored fibers to settle, and
only then rejects. If restoration also fails, an `AggregateError` retains both
the candidate and rollback failures. Stable handles continue to describe the
last committed manifest even when recovery itself cannot become active.

Successful reconciliation commits handle metadata only after the candidate
graph settles. An identical reread therefore preserves handles, loaded plugin
objects, fibers, effects, and capability state. `dispose()` reconciles an empty
manifest, providing an awaitable full shutdown while leaving root-context
ownership with the caller.

```text
desired manifest
      |
validate -> preload -> diff -> dispose/mount -> await
                  |                         |       |
                  |                         |       +-- success: commit
                  |                         +---------- failure: restore old graph
                  +------------------------------------ load failure: no mutation
```

This package deliberately stops at in-memory manifest reconciliation. File
watching, YAML or JSON parsing, cache invalidation, state migration, and CLI
selection belong to later application layers.
