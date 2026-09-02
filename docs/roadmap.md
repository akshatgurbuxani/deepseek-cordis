# Product roadmap

This is the maintained forward-looking plan. Accepted feature history and its
architecture evidence remain in [`../harness/README.md`](../harness/README.md).

## Current milestone: Feature 23

Stabilize bounded whole-document session persistence, recover safely from
post-commit lock cleanup failure, and establish a reproducible performance
baseline. Do not select a new database or event-log format without measurements
from representative coding sessions.

## Next milestone: Feature 24

Add a platform-backed command sandbox. Define `full` enforcement through
adversarial acceptance tests covering host filesystem access, network access,
credentials, descendant processes, cancellation, timeout, and cleanup. Support
one platform honestly before claiming weak portability, and fail closed when
the selected backend is unavailable.

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
