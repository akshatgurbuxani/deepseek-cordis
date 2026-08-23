# Model

`@deepseek-cordis/model` defines the provider-neutral asynchronous completion
contract. Provider packages translate their wire formats at this boundary.

`@deepseek-cordis/model/testing` exports the deterministic replay adapter used
by harness tests. It snapshots its response script and every received request,
so fixtures cannot be rewritten after construction or completion.
