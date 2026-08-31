# `@deepseek-cordis/approval`

Provider-neutral one-shot approval capability. A request identifies one exact
session, turn, tool call, tool, immutable arguments, and declared risk. Outcomes
are closed and a grant is valid for that call only. `UnavailableApprovalService`
is the safe missing-channel provider; `DenyApprovalService` explicitly rejects
every request selected by deployment policy. Neither grants an action.

The capability does not prompt a user or write session events. Channel owners
implement `ApprovalService`; the tool pipeline owns durable asked/decided audit
events around each request.
