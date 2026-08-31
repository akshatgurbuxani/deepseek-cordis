import {
  completeModel,
  type ModelAdapter,
} from '@deepseek-cordis/model'
import {
  type ModelMessage,
  type SessionEvent,
  snapshot,
} from '@deepseek-cordis/protocol'
import {
  deriveSessionSurface,
  type Session,
} from '@deepseek-cordis/session'

export interface SummaryRequest {
  readonly sessionId: string
  readonly messages: readonly ModelMessage[]
  readonly sourceSequences: readonly number[]
}

export interface SummaryOptions {
  readonly signal?: AbortSignal
}

export interface SummaryAdapter {
  readonly id: string
  summarize(request: SummaryRequest, options?: SummaryOptions): Promise<string>
}

export const COMPACTION_INSTRUCTION = [
  'Summarize the conversation history above as a durable checkpoint.',
  'Preserve user goals, established facts, decisions, consequential tool outcomes,',
  'constraints, and unresolved work. Do not claim unfinished work is complete.',
].join(' ')

export class ModelSummaryAdapter implements SummaryAdapter {
  readonly id: string
  readonly #model: ModelAdapter

  constructor(model: ModelAdapter) {
    this.id = `model:${model.id}`
    this.#model = model
  }

  async summarize(request: SummaryRequest, options: SummaryOptions = {}): Promise<string> {
    const response = await completeModel(this.#model, snapshot({
      sessionId: request.sessionId,
      turnId: `${request.sessionId}:compaction`,
      step: 1,
      messages: [
        ...request.messages,
        { role: 'user' as const, content: COMPACTION_INSTRUCTION },
      ],
      tools: [],
    }), options.signal ? { signal: options.signal } : {})
    if (response.type !== 'message') {
      throw new Error('compaction model returned tool calls instead of a summary')
    }
    return response.content
  }
}

export interface CompactionOptions {
  readonly retainTurns?: number
  readonly signal?: AbortSignal
  readonly allowOpenTurn?: boolean
}

export interface CompactionResult {
  readonly event: SessionEvent & { readonly type: 'compaction/summary' }
  readonly sourceMessages: readonly ModelMessage[]
  readonly shadowedSequences: readonly number[]
}

export class CompactionBusyError extends Error {}
export class CompactionChangedError extends Error {}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason
}

interface ExecutionState {
  readonly openTurn?: string
  readonly openStep?: number
}

function executionState(events: readonly SessionEvent[]): ExecutionState {
  let openTurn: string | undefined
  let openStep: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') openTurn = event.turnId
    if (event.type === 'turn/end' && event.turnId === openTurn) openTurn = undefined
    if (event.type === 'step/start') openStep = event.step
    if (event.type === 'step/end' && event.step === openStep) openStep = undefined
  }
  return {
    ...(openTurn ? { openTurn } : {}),
    ...(openStep ? { openStep } : {}),
  }
}

function closedTurnIds(events: readonly SessionEvent[]): readonly string[] {
  return events
    .filter((event) => event.type === 'turn/end')
    .map((event) => event.turnId)
}

export class SessionCompactor {
  readonly #running = new Set<Session>()
  readonly #summarizer: SummaryAdapter

  constructor(summarizer: SummaryAdapter) {
    if (summarizer.id.trim().length === 0) throw new Error('summarizer id must not be empty')
    this.#summarizer = summarizer
  }

  async compact(
    session: Session,
    options: CompactionOptions = {},
  ): Promise<CompactionResult | null> {
    const retainTurns = options.retainTurns ?? 1
    if (!Number.isInteger(retainTurns) || retainTurns < 1) {
      throw new RangeError('retainTurns must be a positive integer')
    }
    throwIfAborted(options.signal)
    if (this.#running.has(session)) {
      throw new CompactionBusyError(`session ${JSON.stringify(session.id)} is already compacting`)
    }
    const initialState = executionState(session.events)
    if (initialState.openStep !== undefined) {
      throw new CompactionBusyError(`session ${JSON.stringify(session.id)} has an open step`)
    }
    if (initialState.openTurn !== undefined && !options.allowOpenTurn) {
      throw new CompactionBusyError(`session ${JSON.stringify(session.id)} has an open turn`)
    }

    const turns = closedTurnIds(session.events)
    if (turns.length <= retainTurns) return null
    const compactableTurns = new Set(turns.slice(0, -retainTurns))
    const surface = deriveSessionSurface(session.events)
    const firstRetained = surface.findIndex((node) => !compactableTurns.has(node.turnId))
    const selected = surface.slice(0, firstRetained === -1 ? surface.length : firstRetained)
    if (selected.length < 2) return null

    const request = snapshot({
      sessionId: session.id,
      messages: selected.map((node) => node.message),
      sourceSequences: selected.map((node) => node.sequence),
    })
    this.#running.add(session)
    try {
      let summary: string
      try {
        summary = await this.#summarizer.summarize(request, {
          ...(options.signal ? { signal: options.signal } : {}),
        })
      } catch (error) {
        throwIfAborted(options.signal)
        throw error
      }
      throwIfAborted(options.signal)
      if (summary.trim().length === 0) throw new Error('summarizer returned an empty summary')
      const currentState = executionState(session.events)
      if (
        currentState.openTurn !== initialState.openTurn
        || currentState.openStep !== initialState.openStep
      ) {
        throw new CompactionChangedError('session execution changed while compaction was running')
      }
      const currentPrefix = deriveSessionSurface(session.events)
        .slice(0, request.sourceSequences.length)
        .map((node) => node.sequence)
      if (
        currentPrefix.length !== request.sourceSequences.length
        || currentPrefix.some((sequence, index) => sequence !== request.sourceSequences[index])
      ) {
        throw new CompactionChangedError('selected session history changed during compaction')
      }

      const boundary = selected.at(-1)
      if (!boundary) return null
      const event = session.append({
        type: 'compaction/summary',
        turnId: boundary.turnId,
        summary,
        shadowedSequences: request.sourceSequences,
        summarizer: this.#summarizer.id,
      })
      return snapshot({
        event,
        sourceMessages: request.messages,
        shadowedSequences: request.sourceSequences,
      })
    } finally {
      this.#running.delete(session)
    }
  }
}
