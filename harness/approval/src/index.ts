import type { ApprovalOutcome, ToolRisk } from '@deepseek-cordis/protocol'

export interface ApprovalRequest {
  readonly sessionId: string
  readonly turnId: string
  readonly callId: string
  readonly toolName: string
  readonly risk: ToolRisk
  readonly reason: string
  readonly signal?: AbortSignal
}

export interface ApprovalService {
  request(request: ApprovalRequest): Promise<ApprovalOutcome>
}

/** Fail-closed provider for unattended compositions and missing UI channels. */
export class UnavailableApprovalService implements ApprovalService {
  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    request.signal?.throwIfAborted()
    return 'unavailable'
  }
}
