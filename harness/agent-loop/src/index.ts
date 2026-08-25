import type { ModelAdapter } from '@deepseek-cordis/model'
import {
  type ModelResponse,
  type RunOptions,
  type RunResult,
  snapshot,
} from '@deepseek-cordis/protocol'
import type { Session, SessionStore } from '@deepseek-cordis/session'
import type { ToolRegistry } from '@deepseek-cordis/tools'

export class StepLimitError extends Error {}

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
    const turnNumber = session.events.filter((event) => event.type === 'turn/start').length + 1
    const turnId = `${session.id}:turn:${turnNumber}`
    this.#running.add(session)
    session.append({ type: 'turn/start', turnId })
    session.append({ type: 'user/message', turnId, content: input })

    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        session.append({ type: 'step/start', turnId, step })
        let response: ModelResponse
        try {
          response = await model.complete(snapshot({
            sessionId: session.id,
            turnId,
            step,
            messages: session.projectMessages(),
            tools: tools.schemas(),
          }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          session.append({ type: 'step/end', turnId, step, outcome: 'failed' })
          session.append({ type: 'turn/error', turnId, error: message })
          session.append({ type: 'turn/end', turnId, status: 'failed' })
          throw error
        }

        if (response.type === 'message') {
          session.append({ type: 'assistant/message', turnId, content: response.content })
          session.append({ type: 'step/end', turnId, step, outcome: 'completed' })
          session.append({ type: 'turn/end', turnId, status: 'completed' })
          return { turnId, content: response.content, steps: step }
        }

        session.append({ type: 'assistant/tool-calls', turnId, calls: response.calls })
        for (const call of response.calls) {
          session.append({ type: 'tool/call', turnId, call })
          const execution = await tools.execute(call.name, call.arguments)
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
      }

      const error = new StepLimitError(`turn exceeded the maximum of ${maxSteps} model steps`)
      session.append({ type: 'turn/error', turnId, error: error.message })
      session.append({ type: 'turn/end', turnId, status: 'failed' })
      throw error
    } finally {
      this.#running.delete(session)
    }
  }
}
