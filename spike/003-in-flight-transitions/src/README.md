# How in-flight transitions work

Spike 002 assumes that one dependency mutation finishes before the next one
arrives. That makes dependency ordering clear, but it avoids a difficult part
of a real lifecycle: setup and cleanup can remain unresolved while the desired
component graph changes again. Spike 003 keeps accepting mutations during that
work. Its responsibility is to let the old transition reach a safe boundary,
discard anything that became stale, and continue toward the newest requested
state.

The central distinction is between desired state and actual state. A fiber's
`desired` field says whether the component is still registered in the newest
graph. Its `state` field says what is happening now: it may be `pending`,
`activating`, `active`, `disposing`, or `disposed`. Those fields are allowed to
disagree temporarily. For example, a fiber can still be `activating` after its
desired state has changed to `disposed`. The runtime does not pretend the setup
promise can be cancelled; it waits for setup, notices that its result is stale,
and immediately recovers the effects that setup acquired.

Every accepted mutation receives a monotonically increasing runtime revision.
The affected fiber and its consumers remember that revision as their newest
target. A revision is useful for recognizing that the desired world changed,
but a number alone is not enough. An activation also snapshots the exact
`ProviderBinding` objects for its requirements. Before publishing anything, it
checks both its desired revision and those provider identities. This prevents a
setup that began with database V1 from becoming active after database V2 has
already replaced it.

The public mutation methods are intentionally synchronous. `add()` validates
the component, creates a pending fiber, updates desired state, and notifies the
scheduler. `remove()` marks a fiber as destined for disposal and immediately
withdraws its service from new resolution. `replace()` performs the withdrawal
and registers the new provider under one revision. None of these methods waits
for arbitrary component code. The caller uses `settle()` when it needs a
barrier after the runtime has had a chance to converge.

Notification and transition settlement are separate processes. `#schedule()`
marks reconciliation dirty and starts a short scheduler run when necessary.
`#drain()` examines the latest graph, starts every currently possible
activation or root deactivation, and tracks those promises without awaiting
the entire batch. Because it does not block on old work, a newly added
independent component can begin setup while another component remains stuck at
an explicit gate.

The `#inflight` set holds the transition promises that the scheduler has
started. When any transition finishes, `#track()` records its error if needed
and schedules another reconciliation pass. This creates a feedback loop:

```text
mutation -> schedule -> start possible transitions
                        |
                        v
                  transition settles
                        |
                        v
             schedule against newest graph
```

The scheduler does not need to predict every mutation that might arrive. It
only needs to recompute the next safe work after each notification and
transition boundary.

Each fiber still has its own serialization boundary. Its `transition` field is
the one setup or cleanup promise currently in flight. `#driveActive()` and
`#driveInactive()` join that promise before starting more work for the same
fiber. Repeated removal notifications, overlapping reconciliation passes, and
multiple callers of `settle()` therefore cannot start a second activation or
cleanup for a fiber that is already transitioning.

Activation begins when `#snapshotTarget()` can resolve every required key from
the published service map. `#activate()` creates a fresh Spike 001
`EffectStack`, saves the provider snapshot as the committed view, and runs
component setup. The component reads dependencies through `context.get()` and
registers reversible work through `context.effect()`. Nothing provided by the
component becomes visible during this phase.

After setup completes, `#targetIsCurrent()` is the publication boundary. If the
fiber is still desired and every required key still points to the exact binding
captured at the start, the fiber becomes active and publishes its services. If
the target changed, `#recoverActivation()` disposes the fresh effect stack,
clears the obsolete committed view, and leaves the fiber pending or disposed.
Consumers can therefore never resolve a service from an activation that
finished successfully but belonged to an obsolete graph.

Setup failure follows a similar recovery path, but it remains observable. The
fiber remembers the failed target and error, rolls back its activation scope,
and returns to a stable state. Remembering the target prevents reconciliation
from retrying the same failing setup forever. A genuinely different provider
snapshot or desired revision creates a new target and may be attempted later.

Withdrawal moves in the opposite direction. `#withdrawCascade()` first removes
the provider's services from the published map. It then follows committed
provider identities through active and activating consumers and withdraws
their provisions too. This synchronous cascade prevents new downstream
activations from entering a graph that is already known to be obsolete, even
though cleanup has not started yet.

`#inactiveRoots()` finds the top providers that need to drain and avoids
starting every invalid consumer as an unrelated root. `#deactivate()` then
walks from each root toward its dependents. It joins consumers that are still
activating, drains active consumers, and joins consumers already disposing.
Only after all of them reach a safe inactive state does it dispose the
provider's own effect stack. This is why a stale repository setup rolls back
before database cleanup and why API cleanup completes before repository
cleanup in a transitive graph.

Committed views remain attached throughout cleanup. A repository disposer can
still read database V1 even though V1 was removed from the published map as
soon as replacement began. The committed map is cleared only after the
fiber-owned `EffectStack` settles. Meanwhile, the new provider waits behind the
old provider through `#hasRetiringProvider()`, so replacement cannot reuse the
same service identity until old consumer and provider resources have drained.

Failures do not break graph recovery. Activation rollback and deactivation
attempt every owned cleanup supplied by the effect stack. A consumer cleanup
error is retained, but its provider still proceeds with its own recovery and
all fibers end in explainable stable states. The runtime collects transition
errors until `settle()` reports them, allowing mutation methods to stay
synchronous without turning lifecycle failures into unhandled promise
rejections.

`settle()` is the convergence barrier. It repeatedly joins the current
scheduler and every tracked transition, including work caused by mutations
accepted while it was already waiting. It resolves only when there is no dirty
notification, no scheduler run, and no in-flight transition left. If lifecycle
errors occurred, it reports them after the graph has finished every recovery
attempt it can perform.

Overall, Spike 003 is a desired-state reconciliation process with safe temporal
boundaries. Mutations say what the graph should become, fibers describe where
the graph is now, provider snapshots guard publication, effect stacks guard
resource ownership, and the scheduler repeatedly closes the gap. It achieves
convergence without claiming that arbitrary user promises can be cancelled and
without weakening the consumer-before-provider teardown rule from Spike 002.
