import type {
  JsonValue,
  SandboxEnforcement,
  ToolRisk,
} from '@deepseek-cordis/protocol'

export interface SandboxRequest {
  readonly sessionId: string
  readonly turnId: string
  readonly callId: string
  readonly toolName: string
  readonly arguments: JsonValue
  readonly risk: ToolRisk
  readonly profile: string
  readonly signal?: AbortSignal
}

export interface SandboxLease {
  readonly provider: string
  readonly enforcement: SandboxEnforcement
  execute(): Promise<JsonValue>
  /** Release preparation resources. Must be idempotent and is always called. */
  dispose(): void | Promise<void>
}

export type SandboxPreparation =
  | { readonly ok: true; readonly lease: SandboxLease }
  | { readonly ok: false; readonly reason: string }

/**
 * A provider prepares one exact execution without running it. The returned
 * lease owns execution; host-local tool code is never passed across this seam.
 */
export interface ToolSandbox {
  prepare(request: SandboxRequest): Promise<SandboxPreparation>
}

/** Fail-closed provider used when no actual isolation backend is composed. */
export class UnavailableToolSandbox implements ToolSandbox {
  async prepare(request: SandboxRequest): Promise<SandboxPreparation> {
    request.signal?.throwIfAborted()
    return { ok: false, reason: 'no sandbox provider is available' }
  }
}
