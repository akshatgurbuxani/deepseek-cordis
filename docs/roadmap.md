# Product roadmap

This is the maintained forward-looking plan. Accepted feature history and its
architecture evidence remain in [`../harness/README.md`](../harness/README.md).

## Completed foundation: Features 23–27

Session persistence is bounded and recovers completed local locks. Command
execution now has explicit local/partial and Docker/full backends with
fail-closed daemon/image preflight and a documented Docker trust boundary.
Coding workspace operations now include bounded recursive discovery,
reviewable versioned patches, atomic multi-hunk publication, and guarded
non-overwriting move/delete.
OpenRouter calls now use explicit provider-routing preferences and bounded,
cancellable pre-stream retries with opt-in live qualification.
The CLI now ships as one installable executable with secure profile
initialization, deterministic session discovery, explicit resume, quiet output,
and actionable persistence-conflict recovery.

## Coding-harness v1 complete

Feature 28 consolidated required packaged, representative-composition, and
adversarial evidence into the supported limits and safe operating profile in
[`coding-harness-v1.md`](coding-harness-v1.md). Further capability work is
evidence-driven rather than part of the v1 checklist.

## Coding-harness v1 sequence

1. Feature 23: persistence stabilization and operational bounds.
2. Feature 24: platform-backed execution isolation.
3. Feature 25: atomic multi-hunk edits, bounded discovery, diff review, and
   separately approved rename/delete operations.
4. Feature 26: bounded provider retries, rate-limit handling, routing policy,
   and live integration qualification.
5. Feature 27: installable CLI, profile initialization, session discovery and
   resume, quiet output, and actionable conflict recovery.
6. Feature 28: representative coding-task and adversarial qualification used to
   select safe defaults and publish supported operational limits.

Attachments, parallel tool execution, subagents, scheduling, automatic profile
watching, UI, and autonomous commits or publication are not required for v1.
They remain deferred until coding-task evidence identifies the next constraint
and the relevant durable ordering and authority contracts are defined.

## Post-v1 candidate sequence

1. Feature 29: expose a bounded per-turn model-step budget and use compatible
   provider routing by default. This addresses observed coding-task failures
   without weakening tool authority.
2. Feature 30: add an unmistakable launch-only
   `--dangerously-skip-approvals` mode. It must never be selectable by a model,
   profile, or environment variable; startup must print a warning, every grant
   must remain durably audited, and ordinary `ask`/`deny` behavior must remain
   unchanged.
3. Feature 31: execute explicitly safe, independent tool calls concurrently
   with a bounded worker count. Results must be committed in original call
   order; mutations and commands remain sequential until observation leases,
   conflicts, cancellation, and partial batch failure have deterministic
   contracts.

This sequence removes interaction friction before adding concurrency. It does
not treat dangerous mode as a sandbox: local commands retain host authority,
while Docker remains the recommended boundary for untrusted workloads.
