# Product roadmap

This is the maintained forward-looking plan. Accepted feature history and its
architecture evidence remain in [`../harness/README.md`](../harness/README.md).

## Completed foundation: Features 23–25

Session persistence is bounded and recovers completed local locks. Command
execution now has explicit local/partial and Docker/full backends with
fail-closed daemon/image preflight and a documented Docker trust boundary.
Coding workspace operations now include bounded recursive discovery,
reviewable versioned patches, atomic multi-hunk publication, and guarded
non-overwriting move/delete.

## Current milestone: Feature 26

Add bounded provider retries, explicit rate-limit handling and routing policy,
then qualify the real OpenRouter path with opt-in live integration evidence.

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
