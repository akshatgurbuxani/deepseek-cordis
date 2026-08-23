# How declarative reconciliation works

Spike 004 knows how to add, remove, and replace components safely, but callers
must issue those mutations themselves. Spike 005 places a desired manifest
above that runtime. A caller supplies the complete configuration it wants, and
the host changes only what differs from the last successful configuration.

Every `ManifestEntry` has a stable `id` and an explicit `revision`. The ID says
which row survived a reread; the revision says whether its module or relevant
configuration changed. When both stay the same, the host retains the same
`EntryHandle`, loaded component, runtime fiber, and owned effects. List position
has no lifecycle meaning.

An entry may name a `parentId`. This is declarative ownership rather than a
service dependency. Disabling a parent makes descendants inactive and removes
the subtree from leaves upward. Re-enabling uses the same handles but creates
fresh fibers because disposed activation scopes cannot be reused.

`reconcile()` queues the manifest behind any active configuration transaction.
`#normalize()` then rejects duplicate IDs, missing parents, and parent cycles.
It calculates tree depth and effective enablement before code is loaded or the
runtime changes.

The host snapshots active entries and classifies desired IDs as preserved,
removed, updated, or added. `#loadChanged()` loads every changed active module
before applying that diff. A syntax or import failure therefore leaves the
exact old fibers alive.

Application removes disabled and absent entries by descending tree depth,
replaces changed entries, and adds new entries. Spike 004 remains responsible
for service ordering, realms, stale transitions, committed dependencies, and
effect cleanup. After `Runtime.settle()` succeeds, `#commit()` advances the
stable handles to their new revisions and fibers.

If mutation or activation fails, `#rollback()` removes all candidate fibers,
waits for their cleanup, re-adds each old component retired by the transaction,
and settles the restored graph. The original error is reported only afterward.
If recovery fails too, both failures are preserved.

Rollback restores composition rather than arbitrary private state. A component
that already drained receives a fresh effect stack. Unrelated entries omitted
from the diff retain their original fibers and state throughout.

```text
manifest
   ↓
validate → preload → diff → apply → settle
              │                 ├── success → commit
              │                 └── failure → compensate → restore
              └── load failure → exact old graph remains
```

Overall, stable IDs preserve configuration identity, revisions make change
detection explicit, preloading protects the live graph from import failure, and
compensating rollback restores the last-known-good composition after activation
failure.
