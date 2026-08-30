import {
  completeModel,
  ModelStreamAbortedError,
  type ModelAdapter,
} from '@deepseek-cordis/model'
import {
  type ModelResponse,
  type RunResult,
  snapshot,
} from '@deepseek-cordis/protocol'
import type { Session, SessionStore } from '@deepseek-cordis/session'
import type { ToolRegistry } from '@deepseek-cordis/tools'

export class StepLimitError extends Error {}

export class TurnCancelledError extends Error {
  constructor(reason?: unknown) {
    super('turn cancelled', reason === undefined ? undefined : { cause: reason })
    this.name = 'TurnCancelledError'
  }
}

export interface RunOptions {
  readonly maxSteps?: number
  readonly signal?: AbortSignal
  readonly onTextDelta?: (delta: string) => void
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TurnCancelledError(signal.reason)
}

export class AgentLoop {
  readonly #running = new Set<Session>()
  #sessions: SessionStore | undefined
  #tools: ToolRegistry | undefined
  #model: ModelAdapter | undefined

  connect(sessions: SessionStore, tools: ToolRegistry, model: ModelAdapter): () => void {
    if (this.#sessions || this.#tools || this.#model) {
      throw new Error('agent loop is already connected')
    }
    this.#sessions = sessions
    this.#tools = tools
    this.#model = model
    let disposed = false
    return () => {
      if (disposed) return
      if (this.#running.size > 0) {
        throw new Error('cannot disconnect the agent loop while a turn is running')
      }
      disposed = true
      this.#sessions = undefined
      this.#tools = undefined
      this.#model = undefined
    }
  }

  async run(session: Session, input: string, options: RunOptions = {}): Promise<RunResult> {
    const sessions = this.#sessions
    const tools = this.#tools
    const model = this.#model
    if (!sessions || !tools || !model) throw new Error('agent loop is not connected')
    if (sessions.get(session.id) !== session) {
      throw new Error(`session ${JSON.stringify(session.id)} does not belong to this loop`)
    }
    if (this.#running.has(session)) {
      throw new Error(`session ${JSON.stringify(session.id)} already has a running turn`)
    }

    const maxSteps = options.maxSteps ?? 8
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new RangeError('maxSteps must be a positive integer')
    }
    throwIfCancelled(options.signal)
    const turnNumber = session.events.filter((event) => event.type === 'turn/start').length + 1
    const turnId = `${session.id}:turn:${turnNumber}`
    this.#running.add(session)
    session.append({ type: 'turn/start', turnId })
    session.append({ type: 'user/message', turnId, content: input })

    let openStep: number | undefined
    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        throwIfCancelled(options.signal)
        session.append({ type: 'step/start', turnId, step })
        openStep = step
        const response: ModelResponse = await completeModel(
          model,
          snapshot({
            sessionId: session.id,
            turnId,
            step,
            messages: session.projectMessages(),
            tools: tools.schemas(),
          }),
          {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
          },
        )
        throwIfCancelled(options.signal)

        if (response.type === 'message') {
          session.append({ type: 'assistant/message', turnId, content: response.content })
          session.append({ type: 'step/end', turnId, step, outcome: 'completed' })
          openStep = undefined
          session.append({ type: 'turn/end', turnId, status: 'completed' })
          return { turnId, content: response.content, steps: step }
        }

        session.append({ type: 'assistant/tool-calls', turnId, calls: response.calls })
        for (const call of response.calls) {
          throwIfCancelled(options.signal)
          session.append({ type: 'tool/call', turnId, call })
          const execution = await tools.execute(call.name, call.arguments, {
            ...(options.signal ? { signal: options.signal } : {}),
          })
          throwIfCancelled(options.signal)
          session.append(execution.ok
            ? {
                type: 'tool/result',
                turnId,
                callId: call.id,
                name: call.name,
                ok: true,
                output: execution.output,
              }
            : {
                type: 'tool/result',
                turnId,
                callId: call.id,
                name: call.name,
                ok: false,
                error: execution.error,
              })
        }
        session.append({ type: 'step/end', turnId, step, outcome: 'tool_calls' })
        openStep = undefined
      }

      throw new StepLimitError(`turn exceeded the maximum of ${maxSteps} model steps`)
    } catch (error) {
      const cancelled = options.signal?.aborted || error instanceof ModelStreamAbortedError
      const failure = cancelled
        ? new TurnCancelledError(options.signal?.reason)
        : error
      if (openStep !== undefined) {
        session.append({
          type: 'step/end',
          turnId,
          step: openStep,
          outcome: cancelled ? 'aborted' : 'failed',
        })
      }
      if (!cancelled) {
        session.append({
          type: 'turn/error',
          turnId,
          error: failure instanceof Error ? failure.message : String(failure),
        })
      }
      session.append({ type: 'turn/end', turnId, status: cancelled ? 'aborted' : 'failed' })
      throw failure
    } finally {
      this.#running.delete(session)
    }
  }
}
