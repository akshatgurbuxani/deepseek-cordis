# `@deepseek-cordis/approval`

Provider-neutral one-shot approval capability. A request identifies one exact
session, turn, tool call, tool, and declared risk. Outcomes are closed and a
grant is valid for that call only. `UnavailableApprovalService` is the safe
headless provider: it never grants an action.

The capability does not prompt a user or write session events. Channel owners
implement `ApprovalService`; the tool pipeline owns durable asked/decided audit
events around each request.
