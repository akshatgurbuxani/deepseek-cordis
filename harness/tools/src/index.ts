import {
  type ApprovalOutcome,
  type JsonValue,
  type SandboxEnforcement,
  snapshot,
  type ToolRisk,
  type ToolExecution,
  type ToolSchema,
} from '@deepseek-cordis/protocol'
import type { ApprovalService } from '@deepseek-cordis/approval'
import type { SandboxLease, ToolSandbox } from '@deepseek-cordis/sandbox'

export interface LocalToolDefinition extends ToolSchema {
  readonly safety: { readonly risk: 'none' }
  readonly execute: (
    argumentsValue: JsonValue,
    options: ToolHandlerOptions,
  ) => JsonValue | Promise<JsonValue>
}

export interface ConsequentialToolDefinition extends ToolSchema {
  readonly safety: {
    readonly risk: ToolRisk
    readonly approvalReason: string
    readonly sandbox: {
      readonly profile: string
      readonly requiredEnforcement: SandboxEnforcement
    }
  }
  readonly execute?: never
}

export type ToolDefinition = LocalToolDefinition | ConsequentialToolDefinition

export interface ToolExecutionContext {
  readonly sessionId: string
  readonly turnId: string
  readonly callId: string
}

export type ToolSafetyAuditEvent =
  | {
    readonly type: 'approval/asked'
    readonly callId: string
    readonly name: string
    readonly risk: ToolRisk
    readonly reason: string
  }
  | {
    readonly type: 'approval/decided'
    readonly callId: string
    readonly name: string
    readonly outcome: ApprovalOutcome
  }
  | {
    readonly type: 'sandbox/prepared'
    readonly callId: string
    readonly name: string
    readonly profile: string
    readonly provider: string
    readonly enforcement: SandboxEnforcement
  }

export interface ToolHandlerOptions {
  readonly signal?: AbortSignal
}

export interface ToolExecutionOptions extends ToolHandlerOptions {
  readonly context?: ToolExecutionContext
  readonly approval?: ApprovalService
  readonly sandbox?: ToolSandbox
  readonly audit?: (event: ToolSafetyAuditEvent) => void
}

export interface ToolRegistry {
  readonly size: number
  register(definition: ToolDefinition): () => void
  schemas(): readonly ToolSchema[]
  execute(
    name: string,
    argumentsValue: JsonValue,
    options?: ToolExecutionOptions,
  ): Promise<ToolExecution>
}

export class InMemoryToolRegistry implements ToolRegistry {
  readonly #definitions = new Map<
    string,
    { readonly owner: ToolDefinition; readonly definition: ToolDefinition }
  >()

  get size(): number {
    return this.#definitions.size
  }

  register(definition: ToolDefinition): () => void {
    if (this.#definitions.has(definition.name)) {
      throw new Error(`tool ${JSON.stringify(definition.name)} is already registered`)
    }
    const normalized = normalizeDefinition(definition)
    if (normalized.safety.risk !== 'none') {
      if (normalized.safety.approvalReason.trim().length === 0) {
        throw new Error(`tool ${JSON.stringify(definition.name)} has an empty approval reason`)
      }
      if (normalized.safety.sandbox.profile.trim().length === 0) {
        throw new Error(`tool ${JSON.stringify(definition.name)} has an empty sandbox profile`)
      }
    }
    const registration = { owner: definition, definition: normalized }
    this.#definitions.set(definition.name, registration)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.#definitions.get(definition.name) === registration) {
        this.#definitions.delete(definition.name)
      }
    }
  }

  schemas(): readonly ToolSchema[] {
    return [...this.#definitions.values()].map(({ definition }) =>
      snapshot({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }),
    )
  }

  async execute(
    name: string,
    argumentsValue: JsonValue,
    options: ToolExecutionOptions = {},
  ): Promise<ToolExecution> {
    options.signal?.throwIfAborted()
    const registration = this.#definitions.get(name)
    if (!registration) {
      return { ok: false, error: `tool ${JSON.stringify(name)} is not registered` }
    }
    const { definition } = registration
    try {
      const isolatedArguments = snapshot(argumentsValue)
      if (definition.safety.risk === 'none') {
        const output = await (definition as LocalToolDefinition).execute(
          isolatedArguments,
          options.signal ? { signal: options.signal } : {},
        )
        options.signal?.throwIfAborted()
        return { ok: true, output: snapshot(output) }
      }

      const { context, approval, sandbox, audit } = options
      if (!context) {
        return { ok: false, error: 'consequential tool execution requires call context' }
      }
      if (!approval) {
        return { ok: false, error: 'approval service is unavailable' }
      }
      if (!sandbox) {
        return { ok: false, error: 'sandbox service is unavailable' }
      }
      if (!audit) {
        return { ok: false, error: 'safety audit sink is unavailable' }
      }

      const approvalRequest = {
        ...context,
        toolName: definition.name,
        risk: definition.safety.risk,
        reason: definition.safety.approvalReason,
        ...(options.signal ? { signal: options.signal } : {}),
      }
      audit({
        type: 'approval/asked',
        callId: context.callId,
        name: definition.name,
        risk: definition.safety.risk,
        reason: definition.safety.approvalReason,
      })
      let outcome: ApprovalOutcome
      try {
        const candidate = await approval.request(approvalRequest)
        outcome = isApprovalOutcome(candidate) ? candidate : 'unavailable'
      } catch (error) {
        options.signal?.throwIfAborted()
        outcome = 'unavailable'
      }
      options.signal?.throwIfAborted()
      audit({
        type: 'approval/decided',
        callId: context.callId,
        name: definition.name,
        outcome,
      })
      if (outcome !== 'allowed-once') {
        return { ok: false, error: approvalFailure(outcome) }
      }

      const preparation = await sandbox.prepare({
        ...context,
        toolName: definition.name,
        arguments: isolatedArguments,
        risk: definition.safety.risk,
        profile: definition.safety.sandbox.profile,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (!isSandboxPreparation(preparation)) {
        options.signal?.throwIfAborted()
        return { ok: false, error: 'sandbox provider returned an invalid preparation' }
      }
      if (!preparation.ok) {
        options.signal?.throwIfAborted()
        return { ok: false, error: preparation.reason }
      }
      const { lease } = preparation
      try {
        options.signal?.throwIfAborted()
        if (!isSandboxLease(lease)) {
          return { ok: false, error: 'sandbox provider returned an invalid lease' }
        }
        if (
          definition.safety.sandbox.requiredEnforcement === 'full'
          && lease.enforcement !== 'full'
        ) {
          return {
            ok: false,
            error: `sandbox provider ${JSON.stringify(lease.provider)} reported partial enforcement`,
          }
        }
        audit({
          type: 'sandbox/prepared',
          callId: context.callId,
          name: definition.name,
          profile: definition.safety.sandbox.profile,
          provider: lease.provider,
          enforcement: lease.enforcement,
        })
        const output = await lease.execute()
        options.signal?.throwIfAborted()
        return { ok: true, output: snapshot(output) }
      } finally {
        if (isSandboxLease(lease)) await lease.dispose()
      }
    } catch (error) {
      options.signal?.throwIfAborted()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

function normalizeDefinition(definition: ToolDefinition): ToolDefinition {
  const schema = {
    name: definition.name,
    description: definition.description,
    inputSchema: snapshot(definition.inputSchema),
  }
  return definition.safety.risk === 'none'
    ? {
        ...schema,
        safety: { risk: 'none' },
        execute: (definition as LocalToolDefinition).execute,
      }
    : {
        ...schema,
        safety: snapshot(definition.safety),
      }
}

function isApprovalOutcome(value: unknown): value is ApprovalOutcome {
  return ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(String(value))
}

function isSandboxPreparation(value: unknown): value is Awaited<
  ReturnType<ToolSandbox['prepare']>
> {
  if (value === null || typeof value !== 'object' || !('ok' in value)) return false
  if (value.ok === false) return 'reason' in value && typeof value.reason === 'string'
  return value.ok === true && 'lease' in value
}

function isSandboxLease(value: unknown): value is SandboxLease {
  return value !== null
    && typeof value === 'object'
    && 'provider' in value
    && typeof value.provider === 'string'
    && value.provider.trim().length > 0
    && 'enforcement' in value
    && ['full', 'partial'].includes(String(value.enforcement))
    && 'execute' in value
    && typeof value.execute === 'function'
    && 'dispose' in value
    && typeof value.dispose === 'function'
}

function approvalFailure(outcome: Exclude<ApprovalOutcome, 'allowed-once'>): string {
  switch (outcome) {
    case 'rejected': return 'tool execution was rejected by approval policy'
    case 'cancelled': return 'tool approval was cancelled'
    case 'unavailable': return 'tool approval is unavailable'
  }
}
