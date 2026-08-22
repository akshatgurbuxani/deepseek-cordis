# How dependency activation works

Spike 001 can safely clean up one owner's resources, but it does not know that
one owner may be using another. If a repository component is using a database,
cleaning up the database first would leave the repository trying to shut down
against a dependency that has already disappeared. Spike 002 adds that missing
relationship. It decides when components are allowed to activate and makes
consumers deactivate before the providers they depend on.

A `ServiceKey<T>` is the identity of one kind of service. It has a readable
name for diagnostics and a unique symbol for runtime identity, while the type
parameter tells TypeScript what value is associated with it. Two calls to
`service('database')` create two different identities even though their names
match. Components therefore share the actual key object when they mean the
same service, rather than depending on accidental string equality.

A `Component` is the declaration of one participant in the runtime. It has a
name, a list of service keys it requires, a list of key/value pairs it provides,
and a setup function. The declaration describes the dependency graph before
anything runs. Registration order does not need to match dependency order: a
repository may be registered before a database and simply wait until the
database becomes available.

Each registered component gets a `Fiber`. The component is the declaration;
the fiber is its changing runtime state. A fiber begins as `pending`, becomes
`active` after successful setup, and becomes `disposed` when it is removed. An
active fiber also owns a fresh Spike 001 `EffectStack` and a committed map of
providers. That committed map is not just a collection of service values. Each
entry remembers both the value and the exact provider fiber from which it came.
This is how the runtime knows which consumers must drain when a particular
provider goes away.

The `Runtime` owns the fibers and a map of currently published services. The
published map answers the question, "What can a new activation resolve right
now?" The committed map on a fiber answers a different question: "What exact
providers did this existing activation start with?" Keeping those views
separate is essential during removal. A service can disappear from new
resolution immediately while remaining readable to an old consumer until that
consumer has finished its cleanup.

The process starts with `add()`. It first checks that the component does not
conflict with another declared provider, creates a pending fiber, and places it
in the runtime. Then `#reconcile()` repeatedly examines pending fibers. A fiber
is eligible only when every required key exists in the published map. Whenever
one activation publishes new services, reconciliation checks the pending
fibers again. This fixed-point loop allows the runtime to activate a chain such
as database, then repository, then API even if those components were registered
in the opposite order.

When a fiber becomes eligible, `#activate()` takes a snapshot of its required
provider bindings and creates a fresh `EffectStack`. It builds a `Context` over
those two pieces of activation state. `context.get()` reads only from the
snapshot, so the component cannot accidentally resolve a provider that was not
part of its activation. `context.effect()` sends resource ownership into the
activation's effect stack. The component setup then runs using that context.

The component's provided services are published only after setup succeeds.
This prevents consumers from observing a provider whose initialization later
fails. If setup does fail, the new effect stack rolls back everything acquired
during that attempt, the committed provider view is cleared, and the fiber
remains pending with its error recorded. No provided service enters the public
map, so downstream consumers remain pending as well.

Removal begins by changing availability, not by immediately destroying the
provider. `#withdraw()` removes the provider's bindings from the published map,
which prevents new activations from selecting it. `#deactivateTree()` then
finds active fibers whose committed maps point to that provider. It recursively
does the same for their consumers, producing leaf-first teardown: an API drains
before its repository, and the repository drains before its database.

During this drain, a consumer keeps its committed map until its effect stack
has finished disposing. Its cleanup can still call `context.get(database)` and
receive the old database object even though that database is no longer
available to new activations. Only after the consumer's cleanup settles does
the runtime clear its committed map and return it to `pending`. After all direct
and transitive consumers are drained, the provider's own effect stack can be
safely disposed.

The `replace()` method joins removal and addition into one dependency-aware
operation. It validates the replacement before disturbing the working
provider. It then drains consumers, disposes the old provider, registers and
activates the new provider, and reconciles the graph again. Consumers receive a
new effect stack and a new committed provider snapshot, so the new activation
cannot accidentally reuse ownership or dependencies from the old one.

The `#enqueue()` method serializes `add()`, `remove()`, and `replace()` calls.
Setup and cleanup may be asynchronous, but Spike 002 lets one mutation finish
before beginning the next. This keeps the experiment focused on dependency
ordering. Handling a new mutation that arrives while activation or teardown is
still running requires stale-transition detection and convergence logic, which
is deliberately left for Spike 003.

Overall, this file implements a small reactive dependency lifecycle. Service
declarations form a graph, reconciliation moves eligible components from
pending to active in provider-to-consumer order, and withdrawal moves them back
toward pending or disposed in consumer-to-provider order. The `Runtime` decides
when components may run, each `Fiber` remembers the exact world in which one
activation began, and each `EffectStack` owns everything that activation must
later undo.
