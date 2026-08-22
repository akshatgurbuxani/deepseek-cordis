# Spike 001: Effect stack

## Question

What is the smallest ownership primitive that can acquire reversible effects, recover completed work after failure, and dispose nested ownership boundaries without disturbing siblings?

## Primary sources

- Paper commit [`948a07b`](https://github.com/cordiverse/paper/commit/948a07b369c62adb3b12e102458be5c18dfb69b9), Section 3 on revertible effects and unified contexts and Section 4 on component recovery.
- Upstream Cordis commit [`8cc9e33`](https://github.com/cordiverse/cordis/commit/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4), package `cordis@4.0.0-rc.8`:
  - [`fiber.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/fiber.ts#L275-L340) for effect collection and single-shot disposal.
  - [`utils.ts`](https://github.com/cordiverse/cordis/blob/8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4/packages/core/src/utils.ts#L4-L31) for reverse registration order.
- DeepSeek Harness commit [`b150a55`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e), vendored package `@deepseek-ai/cordis@4.0.1`:
  - [`fiber.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/fiber.ts#L415-L560) for setup barriers and cleanup joining.
- DeepSeek's [lifecycle and effects tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/cordis-tutorial/02-lifecycle-and-effects.md), which distinguishes reverse disposer start order from concurrent async completion.

## Hypothesis

A scope containing effect records is sufficient for the temporal half of the Cordis model. Each record can collect one or more inverse operations, unwind those operations sequentially in reverse order, and expose a single-shot disposer. A parent scope can own child-scope disposal exactly as it owns any other effect.

## Boundary

The experiment treats in-memory registrations, timers, listeners, and child scopes as reversible when their acquisition supplies a correct disposer. It does not attempt to reverse external emissions or persistent writes. It does not yet implement components, services, reactive dependencies, isolation, interception, or transition cancellation.

The scope waits for setup already in flight; it does not cancel arbitrary user code. Cancellation and dependency changes during setup belong to Spike 003.

## Method

This is an educational reimplementation rather than copied Cordis code or a direct dependency on Cordis. Node's test runner exercises a minimal `EffectStack` with explicit traces. The implementation intentionally preserves two cleanup levels:

- Disposers produced by one effect run sequentially in reverse acquisition order.
- Independent effects begin cleanup in reverse registration order and may await concurrently.

## Acceptance criteria

- Synchronous effects dispose in reverse registration order.
- Multiple disposers produced by one effect unwind sequentially in reverse order.
- Independent asynchronous effects begin in reverse order but may overlap.
- Explicit disposal, repeated disposal, and later owner disposal recover an effect only once.
- Failed asynchronous setup recovers only the acquisition steps that completed.
- Owner disposal safely joins setup already in flight.
- Disposing a child recursively reclaims its effects without touching a sibling.
- Failed activation leaves no registered timer, listener, or service.
- Disposal restores declared local state but does not pretend to retract an external emission.
- One failing disposer does not prevent the remaining cleanup attempts.

## Result

Implemented `EffectStack` as a small, dependency-free TypeScript ownership primitive. Each effect record owns the disposers produced by one setup operation. Calling its returned disposer or disposing the containing scope reaches the same memoized cleanup promise, which makes explicit disposal, owner disposal, and concurrent repeated disposal single-shot.

The experiment confirmed that “reverse-order cleanup” has two meanings:

- Within one effect, disposer completion is strictly sequential in reverse acquisition order.
- Across independent effects, cleanup starts in reverse registration order, but asynchronous work overlaps and can complete in a different order.

Failed generator setup retains each disposer as it is yielded and rolls those completed steps back if a later step throws. Owner disposal can also join setup already in flight without deadlocking. Child scopes use the same ownership mechanism as ordinary effects, so explicitly disposing one child does not affect a sibling and later parent disposal does not recover the first child twice.

Commands run with Node `26.7.0`, npm `11.19.0`, TypeScript `7.0.2`, and `@types/node` `26.2.0`:

```sh
npm install
npm test
npm run typecheck
node --test --experimental-test-coverage test/*.test.ts
```

Observed result:

- 12 tests passed; 0 failed, skipped, or cancelled.
- TypeScript completed with no errors.
- Native coverage reported 94.09% lines, 88.46% branches, and 100.00% functions for `src/effect-stack.ts`.
- The timer, listener, and service failure test observed no surviving registration after rollback.
- The boundary test restored declared in-memory state while preserving an intentionally irreversible external-history entry.

## Decision

The effect ownership model is sufficient to continue to Spike 002, but it is not ready for promotion into `harness/`. Keep the following demonstrated behaviors: per-effect sequential rollback, independent-effect concurrency, memoized single recovery, progressive acquisition tracking, child ownership, and best-effort cleanup with aggregated errors.

Spike 002 should add service keys, provisions, requirements, and pending consumers around this ownership primitive. It must not weaken the effect semantics or introduce lifecycle transition machinery reserved for Spike 003.
