# How context isolation works

Spike 003 indexed every published service by `ServiceKey`. That implies one
provider per key for the entire runtime. Spike 004 changes the index to a
`ProviderSlot`, whose identity is a service key paired with an isolation
boundary.

Every runtime begins with a root `Realm`. A realm can derive children and name
the keys it isolates:

```ts
const model = service<Model>('model')
const agentA = runtime.root.derive({ isolate: [model] })
const agentB = runtime.root.derive({ isolate: [model] })
```

`Realm.slotFor()` walks from the current realm toward the root. It stops at the
nearest realm that isolates the requested key; if no child boundary isolates
the key, it reaches the root. Each stopping point memoizes one slot per key.

This makes the resolution consequences explicit:

```text
root slot(model)
├── ordinary child ────────────────> root slot(model)
├── agent A isolates model ────────> agent A slot(model)
│   └── agent A descendant ────────> agent A slot(model)
└── agent B isolates model ────────> agent B slot(model)
```

Providers publish to the slot computed from their realm. Consumers resolve
requirements from the slot computed from their realm. Two providers conflict
when their computed slots are identical, not merely when their service keys are
identical. Agent A and agent B may therefore publish different `model`
providers, while two components under agent A's isolation boundary still
produce a useful duplicate-provider error.

Isolation is also a cutoff. A root model does not satisfy a consumer below an
isolated model boundary. Keys that are not isolated naturally inherit the root
slot and its provider.

The lifecycle continues to use exact `ProviderBinding` identity. A binding now
retains its slot alongside the provider fiber and value. Activation snapshots
the binding resolved for each required key. Stale-target checks compare the
published object in that binding's slot, and draining follows committed provider
fibers. The algorithms from Spike 003 therefore remain unchanged in shape but
operate on realm-aware identities.

Replacing agent A's model synchronously withdraws only agent A's slot. Only
fibers whose committed maps contain that provider are invalidated. Agent B's
published slot, committed provider, activation, and effects are untouched.

Interception deliberately happens after resolution. A realm can register a
live interceptor for a key:

```ts
const policy = agentA.intercept(model, ({ value, consumer }) =>
  limitModel(value, consumer.name),
)
```

`Context.get()` first looks for the key in the calling fiber's committed map.
If it is absent, access fails even if a provider is globally available. If it
is present, the context starts with the committed raw value and applies the
current interceptor chain from root to leaf, in registration order.

Interceptors do not participate in dependency satisfaction and do not replace
the committed binding. Updating or disposing an interceptor immediately changes
the next `get()` result without scheduling reconciliation or restarting the
consumer. An interceptor may inspect the consumer and provider fibers, wrap the
value, record usage, or throw an access error.

This separation is important:

```text
service key + realm
        |
        v
resolve exact provider binding  ----> lifecycle and dependency identity
        |
        v
apply live interceptor chain    ----> policy and service usage
        |
        v
return or reject Context.get()
```

Interception is mediation, not containment. Cooperative plugins that obtain
capabilities only through `Context.get()` can be checked and wrapped. Ordinary
TypeScript code can still use an imported module, a previously captured object,
filesystem APIs, or the network directly. The boundary test keeps a raw object
reference and reads it even while context policy denies access, demonstrating
why hostile plugins require a process, VM, WebAssembly, or container sandbox.
