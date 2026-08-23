# Protocol

`@deepseek-cordis/protocol` owns immutable values shared across harness
capability boundaries. It contains no service implementation, I/O, or Cordis
integration.

`snapshot()` creates a structured clone and recursively freezes it. Providers
use this at ingress so later mutation of a caller-owned object cannot rewrite a
recorded event, model request, tool schema, or tool result.
