# Agent loop

`@deepseek-cordis/agent-loop` turns one user input into bounded model and tool
steps. It depends only on the public session, model, tool, and protocol
contracts. It does not import Cordis, a network provider, configuration, or UI.

`connect()` gives one stable loop facade its current providers and returns an
idempotent disposer. A runtime adapter can therefore drain the loop, replace a
provider, and reconnect the same facade without replacing session history.
Disconnecting during a running turn fails and remains retryable after the turn
settles.

`run()` appends turn and user events, then repeatedly projects model-visible
history from the session and reads current tool schemas. A final message closes
the turn. Tool calls are recorded and executed in model order; every result is
recorded before the next model request.

Model failures and the maximum-step guard append durable failed-turn events.
The per-session run lock is released in `finally`, so later turns remain
possible after success or failure.

```text
append user input
       ↓
project session events + read live tool schemas
       ↓
call model
  ├── final message → record and finish
  └── tool calls    → record, execute, record results, repeat
```
