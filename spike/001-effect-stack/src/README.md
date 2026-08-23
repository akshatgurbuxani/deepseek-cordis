# How the effect stack works

This spike is a small resource-lifecycle manager. Its job is to remember what a
piece of setup changed and later perform the matching cleanup. The setup may
register an event listener, start a timer, open a connection, or place a value
in a registry. The stack cannot invent a way to undo those actions, so the
setup supplies disposer functions such as `removeEventListener`,
`clearInterval`, or `connection.close`. The stack owns those functions and
makes sure they run at the correct time and at most once.

The first important value is `EffectValue`. It describes what setup is allowed
to produce: nothing, one disposer, a normal iterable of disposers, or an async
iterable of disposers. Supporting iterables lets one setup operation describe
several acquisition steps. For example, it can acquire a timer, yield the
timer's disposer, acquire a listener, and then yield the listener's disposer.
Recording each disposer as soon as it is produced matters because a later
acquisition can fail. The stack can still recover every earlier step that
finished successfully.

Every call to `effect()` creates an `EffectRecord`. This record is the history
of one setup operation. It contains the collected disposers, the promise that
represents setup, flags describing whether setup completed or failed, the
original setup error, and eventually a disposal promise. Storing the disposal
promise makes cleanup single-shot: an explicit call to the effect's disposer,
a concurrent second call, and disposal of the whole owner all join the same
promise instead of repeating the cleanup.

The `EffectStack` is the owner of all those records. It begins in the `active`
state, where effects and child stacks may be added. Once `dispose()` is called,
it moves to `disposing`, which prevents new acquisitions. After all cleanup
attempts settle, it becomes `disposed`. This state progression prevents a
resource from entering the stack after teardown has already taken its snapshot
of the owned work.

The normal flow starts in `effect()`. A new empty record first goes into the
stack, and then `#collect()` runs the supplied setup. Registering the record
before setup finishes is deliberate. If owner disposal begins while setup is
still awaiting something, the owner already knows that the setup exists and
can wait for it. As setup produces disposer functions, `#collect()` validates
and appends them to the record. When setup succeeds, `effect()` returns a small
function that disposes only that record.

If setup fails, the flow turns into rollback. The record remembers the original
error and `#disposeRecord()` runs whatever disposers were collected before the
failure. If rollback succeeds, the caller receives the original setup error. If
rollback also fails, both errors are placed in an `AggregateError`; otherwise
the cleanup failure would hide the reason setup failed, or the setup failure
would hide a resource that could not be recovered.

When one record is disposed, `#disposeRecord()` first waits for in-flight setup
to settle. It removes the collected disposer list from the record, reverses it,
and awaits each disposer sequentially. If acquisition happened as A, then B,
then C, recovery happens as C, then B, then A. A failing disposer is recorded
without stopping the remaining cleanup attempts. Finally, `#remove()` removes
the record from its owner, and any collected cleanup errors are reported
together.

Whole-stack disposal has a second level of ordering. `dispose()` takes all
effect records in reverse registration order and starts their cleanup in that
order. Those independent records may run concurrently, so the last record
starts first but does not necessarily finish first. Inside each individual
record, however, its disposer functions remain strictly sequential. This gives
fast independent cleanup without weakening the ordering between acquisition
steps that belong to the same effect.

The `child()` method uses the same ownership idea rather than creating a
separate teardown system. A child stack is placed in its parent as a record
whose disposer calls `child.dispose()`. The child owns its own effects, while
the parent owns the lifetime of the child. Disposing one child therefore leaves
its siblings alone, and disposing the parent recursively recovers every child
that is still alive.

Overall, the file implements stack-shaped resource management. Setup moves
resources into an ownership boundary while recording their inverse operations.
Disposal moves those operations back out in reverse order. The implementation
does not claim that every real-world action is reversible; it guarantees only
that declared cleanup work is retained, ordered, attempted, and never
intentionally run twice.
