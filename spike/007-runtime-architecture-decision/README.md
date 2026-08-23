# Spike 007: Runtime architecture decision

## Question

Should the production harness depend on a pinned upstream Cordis runtime,
vendor a pinned Cordis snapshot, or promote the educational runtime built in
Spikes 001–005 into a maintained local framework?

## Why this follows Spike 006

Spike 006 proved that the mechanisms from the first five spikes can support a
recognizable agent turn. Its session, model, tool, and loop services work, but
they import the educational runtime directly from Spike 004 and the declarative
host from Spike 005. Promoting that dependency chain unchanged would quietly
turn several disposable experiments into a framework we must maintain.

Before creating production packages or adding a real network model adapter, we
need to decide who owns the composition runtime. That choice affects every
plugin API, package dependency, loader decision, test boundary, and future
upgrade.

## Current comparison targets

- Upstream [`cordis`](https://github.com/cordiverse/cordis) package version
  `4.0.0-rc.8`, published from commit
  [`f46ae95`](https://github.com/cordiverse/cordis/commit/f46ae95e039f156b966e1e0f7e8d1af91e73e9db).
  The package is ESM-first and provides the core context, service, lifecycle,
  and optional loader seams.
- DeepSeek Harness's
  [vendored framework layer](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md),
  which currently owns an auditable, patchable Cordis snapshot inside its
  monorepo instead of resolving the runtime from npm.
- The local educational runtime in Spikes 001–005. It is useful as an
  executable specification, but its READMEs intentionally avoid approving it
  for production.

All comparisons must pin an exact package version or commit. Floating `main`
and `master` links are background context, not reproducible implementation
inputs.

## Options

### A. Pin upstream Cordis from npm

The harness consumes an exact `cordis` release and keeps only harness-specific
services locally. This minimizes framework ownership and follows the upstream
public API, but an unstable release may force coordinated upgrades or expose a
behavioral gap we cannot fix promptly.

### B. Vendor a pinned upstream snapshot

The harness copies a declared Cordis commit into the repository and records
local modifications. This makes builds auditable and gives us control over
patch timing, but it also creates an explicit synchronization and publication
burden.

### C. Maintain the local runtime

The harness promotes the runtime demonstrated by the spikes. This gives direct
control and the smallest known API, but commits the project to owning lifecycle
concurrency, dependency resolution, isolation, configuration loading, HMR, and
compatibility indefinitely.

## Hypothesis

Prefer an exact upstream `cordis` dependency if a thin integration can preserve
the harness-level invariants from Spike 006 without reaching into upstream
private internals. Vendor only if reproducible builds or a concrete blocking
gap requires source ownership. Do not promote the educational runtime unless
both upstream routes fail a documented requirement.

The spikes remain the behavioral oracle regardless of the selected runtime.
They explain the mechanisms and provide focused regression scenarios; they do
not need to become the production dependency.

## Evaluation criteria

Score each viable option against the same evidence:

1. **Behavioral parity:** reversible cleanup, dependency-driven activation,
   safe replacement, scoped service resolution, and failed-load recovery.
2. **Public-API fit:** the Spike 006 services can be expressed without importing
   private source paths or duplicating runtime state.
3. **Operational ownership:** patching, security response, release cadence, and
   upgrade work have a clear owner.
4. **Reproducibility:** installs resolve the same source and behavior in local
   development and CI.
5. **Package hygiene:** harness packages depend on stable capability contracts,
   not spike directories or loader implementation details.
6. **Failure visibility:** activation and reload failures remain observable and
   leave an explainable last-known-good state.

## Proposed experiment

Build the smallest upstream-Cordis composition that can execute the Spike 006
calculator turn:

```text
session service ─┐
tool service ────┼──> agent-loop plugin ──> recorded completed turn
model service ───┘
```

Keep the harness contracts provider-neutral. Replace only the composition
adapter first, then test these scenarios against the pinned upstream runtime:

- activate the loop only after all three providers exist;
- own tool registration and connection cleanup through plugin effects;
- remove and replace a tool without losing the session log;
- replace a model and make the next turn use it;
- contain a failed replacement or document precisely where the loader must
  supply last-known-good recovery;
- isolate two model providers for two derived contexts if the public API
  supports that boundary;
- dispose the composition and prove registrations and connections drain once.

If upstream Cordis does not itself own declarative rollback, test the official
loader/HMR boundary rather than treating a missing core feature as automatic
failure. Record which layer owns each invariant.

## Production package boundary to decide

The experiment should end with a concrete dependency direction resembling:

```text
runtime dependency or vendored framework
                 ↓
harness capability contracts
  sessions | models | tools
                 ↓
agent loop
                 ↓
composition/boot application
                 ↓
CLI, model providers, tools, and storage implementations
```

The stable contracts must not import the declarative loader. Provider packages
implement one capability. The loop consumes contracts. Boot owns configuration
and plugin-tree assembly. A real model adapter belongs above these boundaries,
so choosing a provider API does not decide the composition runtime.

## Boundary

This spike selects architecture; it does not begin the production harness or
add product features. It excludes streaming, persistence, UI, permissions,
subagents, and a polished CLI. A tiny model or tool fake is sufficient because
the subject is runtime integration, not model quality.

Do not copy all of Spike 006 into a second implementation. Reuse or extract only
enough provider-neutral contracts to reveal the integration seam. Any adapter
that exists solely for the comparison remains spike code.

## Acceptance criteria

- Pin and record the exact upstream Cordis package version and source commit
  used by the experiment.
- Run one complete model/tool/model turn through public Cordis APIs.
- Demonstrate lifecycle ownership for tool registration and loop connection.
- Test provider removal, provider replacement, scoped resolution, and disposal.
- Locate last-known-good failed-reload responsibility in core, loader/HMR, or
  harness boot and verify it at the correct layer.
- Produce a comparison table for npm pin, vendored snapshot, and local runtime.
- Make one explicit runtime decision with rejected alternatives and triggers
  that would cause the decision to be revisited.
- Define production package boundaries and allowed dependency directions.
- Leave all spike source educational and unreferenced by production packages.

## Suggested implementation order

1. Pin upstream Cordis and map its public context, service, effect, scope, and
   loader APIs to the vocabulary proven in Spikes 001–006.
2. Write a narrow composition adapter for the Spike 006 service contracts.
3. Execute the calculator vertical slice through that adapter.
4. Add parity tests for cleanup, replacement, isolation, and failure behavior.
5. Identify whether declarative reconciliation belongs to Cordis core, its
   loader/HMR plugins, or harness boot.
6. Compare maintenance and reproducibility costs of npm, vendoring, and local
   ownership using observed evidence.
7. Record the architecture decision and production package graph.
8. Only after the decision, branch the first production harness package.

## Expected decision record

The result section must state:

- **Decision:** the selected runtime ownership model.
- **Evidence:** commands and behavioral results that justify it.
- **Consequences:** what the project owns and delegates.
- **Rejected alternatives:** why each other option lost.
- **Revisit triggers:** upstream API stabilization, an unresolved defect,
  publication constraints, or requirements the selected runtime cannot meet.

## Result

The Spike 006 session, tool, model, and agent-loop objects were composed through
the public API of `cordis@4.0.0-rc.8`, published from commit `f46ae95`. The npm
lock records integrity
`sha512-vXaYK6XZJlIFTnODp4Rd973Qnd/gm3cwFzWsMTaeu6cQQheA7N+aA0GqHRNl0cFIrxMXWU8dst1ZXHlUQvfyRw==`.
No Cordis private source path was imported and no local `Runtime` or
`DeclarativeHost` instance participated in composition.

The original seven runtime tests demonstrated:

- a loop fiber remained pending until sessions, tools, and model providers were
  active, then completed the same calculator turn as Spike 006;
- an effect-owned tool registration disappeared on fiber disposal, and its
  replacement changed later execution without replacing session history;
- model replacement drained and reconnected one stable loop facade;
- harness boot restored the previous model plugin after a candidate threw
  during setup, after which the same session completed another turn;
- two contexts inherited shared sessions and tools while resolving isolated
  model and loop services;
- nested Cordis effects disposed once in reverse acquisition order; and
- disposing the loop withdrew its service and disconnected its facade.

Native test coverage reported 100.00% lines, branches, and functions for the
new `src/cordis-harness.ts` integration adapter.

Three additional tests cover the OpenRouter wire adapter: complete history and
tool-schema translation, normalized tool calls and usage, final text, HTTP
failure containment, and malformed tool arguments. All ten tests pass. Native
coverage reported 94.63% lines and 100.00% functions for `src/openrouter.ts`.

Two public-package constraints were observed. The published declaration files
use extensionless relative exports, so TypeScript `NodeNext` resolution rejected
them with `TS2834`. `moduleResolution: "Bundler"` typechecked successfully.
The runtime-exported `FiberState` is declared as an ambient `const enum`, so
`verbatimModuleSyntax` produced `TS2748`; omitting that flag allowed the public
declaration to typecheck. These are integration constraints, not behavioral
failures, and they are isolated to the Cordis-facing package.

Commands run with Node `26.7.0`, npm `11.19.0`, TypeScript `7.0.2`, and
`cordis` `4.0.0-rc.8`:

```sh
npm install
npm run typecheck
npm test
node --test --experimental-test-coverage test/*.test.ts
```

## Runnable agent trace

The spike now includes a terminal demonstration that makes the whole path
visible. First run it with the deterministic replay adapter; no key or network
request is involved:

```sh
cd spike/007-runtime-architecture-decision
npm install
npm run demo:replay -- "Please add 17 and 25 using the tool"
```

The output shows each Cordis fiber moving from pending through active, every
append-only session event, each projected model request, the model response,
the local tool call and result, the final answer, and reverse-order fiber
disposal.

To use a real model, copy the ignored environment template and edit `.env`
locally:

```sh
cp .env.example .env
```

```dotenv
OPENROUTER_API_KEY=your-key
OPENROUTER_MODEL=openrouter/free
```

Then run:

```sh
npm run demo:openrouter -- "Use the add tool to calculate 123 + 456"
```

`OPENROUTER_MODEL` overrides the provider without changing source. It can name
any OpenRouter model that supports tool calling. The demo defaults to
`openrouter/free`, logs the model OpenRouter actually selected and token usage,
and never includes the API key in model requests or trace output.

`OpenRouterModelAdapter` translates the provider-neutral Spike 006 transcript
into OpenRouter chat-completion messages and function tools. It normalizes a
returned function call into the harness `ToolCall`, after which the existing
agent loop executes the local tool and sends the recorded result into the next
request. HTTP failures and malformed tool arguments become explicit adapter
errors and durable failed-turn events.

### OpenRouter routing-policy errors

An authenticated smoke test with
`deepseek/deepseek-v4-flash-vision-exp` reached OpenRouter but its only active
DeepSeek endpoint was excluded by the API key's effective privacy/guardrail
policy. The adapter requests routing metadata and turns that response into a
specific diagnostic covering non-frontier ZDR, provider data-collection policy,
and model/provider allowlists. The session still durably recorded the failed
step and turn before Cordis cleaned up every fiber.

This response is not an invalid-key failure. Confirm a key independently, if
needed, without making a model call:

```sh
node --env-file-if-exists=.env --input-type=module -e \
  'const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` } }); console.log({ status: r.status, authenticated: r.ok })'
```

If the selected model has no endpoint compatible with the desired policy,
either choose a tool-capable model with an eligible endpoint or intentionally
change the account/key policy in OpenRouter Settings > Privacy. A request-level
option cannot weaken an account or guardrail restriction.

## Comparison

| Option | Behavioral fit | Reproducibility | Project ownership | Decision |
| --- | --- | --- | --- | --- |
| Exact npm pin | Passed all seven public-API scenarios; requires isolated TypeScript compiler settings | Exact version, lockfile integrity, and source commit are recorded | Harness owns its adapter and boot rollback; upstream owns runtime internals | **Selected** |
| Vendored snapshot | Expected to preserve the same runtime behavior and permits local declaration fixes | Strongest source-level auditability | Project must sync, patch, license, build, and eventually publish the framework layer | Reserve for a demonstrated distribution or patching need |
| Local educational runtime | Passed the earlier focused spikes and Spike 006 | Entire source is local | Project permanently owns framework correctness, loaders, HMR, concurrency, and compatibility | Rejected for production |

## Decision

Use an exact npm dependency on `cordis@4.0.0-rc.8` for the first production
harness. Keep Cordis imports inside a dedicated composition package compiled
with `moduleResolution: "Bundler"`; capability contracts and agent behavior
must not depend on Cordis types.

Harness boot owns ordered configuration changes and last-known-good rollback.
Cordis core owns effects, dependency-driven fiber activation, service
resolution, isolation, and cleanup. A future loader may replace the small boot
adapter, but the capability packages must not know which loader is used.

The initial production package direction is:

```text
harness/session     harness/model     harness/tools
        \                |                /
         \               |               /
                  harness/agent-loop
                           |
                 harness/runtime-cordis
                           |
                    harness/app-boot
                     /             \
       model provider packages    tool/storage packages
```

- `session`, `model`, and `tools` define capability contracts and their core
  in-memory behavior without importing Cordis.
- `agent-loop` depends only on those contracts.
- `runtime-cordis` adapts capability providers and consumers into Cordis
  plugins and contains the required compiler-resolution exception.
- `app-boot` owns manifests, ordering, replacement, and rollback.
- concrete model, tool, and storage packages implement contracts and expose
  plugins through the adapter boundary.

Do not promote or import the source of Spikes 001–007 into these packages. The
spikes remain executable explanations and regression references.

### Consequences

The project delegates its hardest lifecycle state machine to upstream Cordis
while retaining control of harness semantics. Exact pinning prevents accidental
release drift. Upgrades are deliberate compatibility exercises, and the
Cordis-facing compiler exception cannot leak into provider-neutral packages.

Boot must implement or adopt declarative reconciliation; core Cordis fibers do
not by themselves remember an old manifest and choose to restore it. The spike's
`replaceWithRollback()` proves the ownership boundary but is not the production
loader.

### Rejected alternatives

Vendoring is rejected initially because no runtime defect or offline/publishing
requirement currently justifies owning an upstream source fork. The local
runtime is rejected because the public Cordis API satisfied every tested
behavior, making permanent ownership of a second lifecycle framework needless.

### Revisit triggers

Reconsider vendoring if a blocking runtime or declaration defect cannot be
resolved upstream, builds must work without registry access, publication must
ship one audited framework closure, or local patches become necessary.
Reconsider the exact version when Cordis stabilizes its v4 API. Reconsider the
runtime choice entirely if production requirements fail the same behavioral
parity suite through public APIs.

## Next implementation steps

Spike 007 closes the disposable runtime-learning sequence. The next work should
begin production code under `harness/`, without importing spike source:

1. Create the workspace and provider-neutral `session`, `model`, and `tools`
   packages, including immutable events and in-memory reference providers.
2. Implement `agent-loop` against only those contracts and port the Spike 006
   behavioral suite.
3. Add `runtime-cordis`, containing the Cordis service declarations and plugin
   adapters proven here, with the compiler-resolution exception isolated there.
4. Add `app-boot`, owning manifest identity, ordered mounting, replacement, and
   last-known-good rollback.
5. Promote the OpenRouter adapter into a model-provider package and add a small
   text CLI that selects a model through configuration rather than source edits.
6. Replace in-memory sessions with a persistent provider, then add streaming
   and cancellation before expanding the tool surface.
7. Add permissions and approval policy before exposing filesystem, shell, or
   other consequential tools.

The first production milestone is one text-only CLI turn with one model and one
calculator tool, backed by the same event trace and lifecycle tests. Persistence
is the next milestone; streaming and broader agent capabilities follow only
after that durable boundary exists.
