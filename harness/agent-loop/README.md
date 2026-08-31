# Agent loop

`@deepseek-cordis/agent-loop` turns one user input into bounded model and tool
steps. It depends only on the public session, model, tool, approval, sandbox,
system-prompt, and protocol
contracts. It does not import Cordis, a network provider, configuration, or UI.

`connect()` gives one stable loop facade its current providers and returns an
idempotent disposer. A runtime adapter can therefore drain the loop, replace a
provider, and reconnect the same facade without replacing session history.
Disconnecting during a running turn fails and remains retryable after the turn
settles.

`run()` appends turn and user events, then repeatedly projects model-visible
history from the session and resolves one coherent prompt/tool assembly. Model text deltas are
forwarded live while only the terminal response enters session history. Tool
calls are recorded and executed in model order; every result is recorded before
the next model request.

For consequential calls, the loop supplies exact session/turn/call identity and
commits `approval/asked`, `approval/decided`, and `sandbox/prepared` audit events
through the tool pipeline. These events are log-only. A failed audit append
prevents dispatch, while the ordinary tool result remains the only new
model-visible message.

Model failures and the maximum-step guard append durable failed-turn events.
An optional turn signal propagates through model and tool work. Cancellation
records aborted step and turn boundaries without persisting a runtime-only abort
reason or partial assistant text. Unanswered tool calls receive conservative
failed results so projected history remains a valid model transcript.
The per-session run lock is released in `finally`, so later turns remain
possible after success or failure.

An optional `AgentLoopPolicy` runs at the maintenance boundary before request
derivation and may inspect a failed model call. Tool schemas are read again
after policy work, so a slow policy cannot freeze a stale registry snapshot.
The policy receives the same live-schema reader, allowing measurement after an
asynchronous metadata lookup to use the envelope that will actually be sent.
It can resolve the corresponding cached prompt after that lookup; the final
request uses the exact tool snapshot against which dynamic sections ran.
Recovery starts a new durable step only when the policy reports a surface
change; the failed attempt remains closed in the log.

When a successful finish includes provider usage, the loop records it on the
assistant event with the exact input-surface sequence list, tool schemas, and
system prompt used for that call. The metadata stays outside model projection while giving a
restarted token meter a verifiable request anchor.

```text
append user input
       ↓
project session events + assemble scoped prompt/live tools
       ↓
stream model
  ├── text delta    → forward live
  ├── final message → record and finish
  └── tool calls    → record, execute, record results, repeat
```
