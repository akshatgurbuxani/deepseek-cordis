import type { AgentLoopPolicy, AgentLoopPolicyContext } from '@deepseek-cordis/agent-loop'
import type { SessionCompactor } from '@deepseek-cordis/compaction'
import { ModelContextOverflowError, resolveModelInfo } from '@deepseek-cordis/model'
import type { SessionEventInput } from '@deepseek-cordis/protocol'
import type { Session } from '@deepseek-cordis/session'
import { type TokenMeasurement, TokenMeter } from '@deepseek-cordis/token-meter'

type WithoutTurn<Event> = Event extends unknown ? Omit<Event, 'turnId'> : never

export interface ContextBudgetPolicyOptions {
  readonly compactor: SessionCompactor
  readonly meter?: TokenMeter
  readonly thresholdRatio?: number
  readonly retainTurns?: number
  readonly maxOverflowRetries?: number
}

function positiveInteger(value: number, name: string, allowZero = false): number {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
  return value
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().length > 0 ? message : 'context budget policy failed'
}

export class ContextBudgetPolicy implements AgentLoopPolicy {
  readonly #compactor: SessionCompactor
  readonly #meter: TokenMeter
  readonly #thresholdRatio: number
  readonly #retainTurns: number
  readonly #maxOverflowRetries: number
  readonly #overflowAttempts = new WeakMap<
    Session,
    {
      readonly turnId: string
      readonly attempts: number
    }
  >()

  constructor(options: ContextBudgetPolicyOptions) {
    if (
      options.thresholdRatio !== undefined &&
      (!Number.isFinite(options.thresholdRatio) ||
        options.thresholdRatio <= 0 ||
        options.thresholdRatio >= 1)
    )
      throw new RangeError('thresholdRatio must be greater than zero and less than one')
    this.#compactor = options.compactor
    this.#meter = options.meter ?? new TokenMeter()
    this.#thresholdRatio = options.thresholdRatio ?? 0.8
    this.#retainTurns = positiveInteger(options.retainTurns ?? 1, 'retainTurns')
    this.#maxOverflowRetries = positiveInteger(
      options.maxOverflowRetries ?? 1,
      'maxOverflowRetries',
      true,
    )
  }

  async beforeStep(context: AgentLoopPolicyContext): Promise<void> {
    throwIfAborted(context.signal)
    let contextWindow: number | undefined
    try {
      contextWindow = (
        await resolveModelInfo(context.model, {
          ...(context.signal ? { signal: context.signal } : {}),
        })
      ).contextWindow
    } catch {
      throwIfAborted(context.signal)
      return
    }
    if (contextWindow === undefined) return
    const systemPrompt = await context.readSystemPrompt()
    throwIfAborted(context.signal)
    const measurement = this.#meter.measure(context.session, context.readTools(), {
      model: context.model.id,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
    })
    const thresholdTokens = Math.max(1, Math.floor(contextWindow * this.#thresholdRatio))
    if (measurement.totalTokens < thresholdTokens) return
    await this.#attempt(context, 'pressure', measurement, thresholdTokens, contextWindow)
  }

  async recoverModelError(context: AgentLoopPolicyContext, error: unknown): Promise<boolean> {
    if (!(error instanceof ModelContextOverflowError)) return false
    throwIfAborted(context.signal)
    const previous = this.#overflowAttempts.get(context.session)
    const attempts = previous?.turnId === context.turnId ? previous.attempts : 0
    if (attempts >= this.#maxOverflowRetries) return false
    this.#overflowAttempts.set(context.session, {
      turnId: context.turnId,
      attempts: attempts + 1,
    })
    const measurement = this.#meter.measure(context.session, context.tools, {
      model: context.model.id,
      ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    })
    return this.#attempt(
      context,
      'context_overflow',
      measurement,
      undefined,
      context.model.contextWindow,
    )
  }

  async #attempt(
    context: AgentLoopPolicyContext,
    trigger: 'pressure' | 'context_overflow',
    measurement: TokenMeasurement,
    thresholdTokens?: number,
    contextWindow?: number,
  ): Promise<boolean> {
    let decision: WithoutTurn<
      Extract<
        SessionEventInput,
        {
          readonly type: 'context-budget/decision'
        }
      >
    >
    const triggerMetadata =
      trigger === 'pressure'
        ? (() => {
            if (contextWindow === undefined || thresholdTokens === undefined) {
              throw new Error('pressure policy requires capacity and threshold metadata')
            }
            return {
              trigger,
              contextWindow,
              thresholdTokens,
            } as const
          })()
        : ({
            trigger,
            ...(contextWindow === undefined ? {} : { contextWindow }),
          } as const)
    try {
      const result = await this.#compactor.compact(context.session, {
        retainTurns: this.#retainTurns,
        allowOpenTurn: true,
        ...(context.signal ? { signal: context.signal } : {}),
      })
      const base = {
        type: 'context-budget/decision',
        model: context.model.id,
        measuredTokens: measurement.totalTokens,
        ...triggerMetadata,
      } as const
      decision = result
        ? {
            ...base,
            outcome: 'compacted',
            summarySequence: result.event.sequence,
          }
        : {
            ...base,
            outcome: 'no_progress',
          }
    } catch (error) {
      throwIfAborted(context.signal)
      decision = {
        type: 'context-budget/decision',
        model: context.model.id,
        measuredTokens: measurement.totalTokens,
        ...triggerMetadata,
        outcome: 'failed',
        error: safeErrorMessage(error),
      }
    }
    switch (decision.outcome) {
      case 'compacted':
        context.session.append({ ...decision, turnId: context.turnId })
        break
      case 'no_progress':
        context.session.append({ ...decision, turnId: context.turnId })
        break
      case 'failed':
        context.session.append({ ...decision, turnId: context.turnId })
        break
    }
    return decision.outcome === 'compacted'
  }
}
