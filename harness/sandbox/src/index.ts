import type { JsonValue, SandboxEnforcement, ToolRisk } from '@deepseek-cordis/protocol'

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

/** Route sandbox requests by their declared profile without weakening either provider. */
export class ProfiledToolSandbox implements ToolSandbox {
  readonly #providers: ReadonlyMap<string, ToolSandbox>

  constructor(routes: Readonly<Record<string, ToolSandbox>> | ReadonlyMap<string, ToolSandbox>) {
    const entries = routes instanceof Map ? [...routes] : Object.entries(routes)
    const providers = new Map<string, ToolSandbox>()
    for (const [profile, provider] of entries) {
      if (profile.trim().length === 0) throw new Error('sandbox route profile must not be empty')
      if (providers.has(profile)) {
        throw new Error(`sandbox route ${JSON.stringify(profile)} is duplicated`)
      }
      providers.set(profile, provider)
    }
    this.#providers = providers
  }

  async prepare(request: SandboxRequest): Promise<SandboxPreparation> {
    request.signal?.throwIfAborted()
    const provider = this.#providers.get(request.profile)
    if (!provider) {
      return {
        ok: false,
        reason: `no sandbox provider is registered for profile ${JSON.stringify(request.profile)}`,
      }
    }
    return provider.prepare(request)
  }
}
