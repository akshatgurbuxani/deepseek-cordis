import type {
  ApprovalRequest,
  ApprovalService,
} from '@deepseek-cordis/approval'
import type { ModelAdapter, ModelStreamOptions } from '@deepseek-cordis/model'
import {
  type ModelRequest,
  type JsonValue,
  snapshot,
  type ModelStreamChunk,
} from '@deepseek-cordis/protocol'

export interface ApprovalPresentation {
  readonly sessionId: string
  readonly turnId: string
  readonly callId: string
  readonly toolName: string
  readonly arguments: JsonValue
  readonly risk: ApprovalRequest['risk']
  readonly reason: string
}

export type ApprovalPrompt = (
  request: ApprovalPresentation,
) => boolean | undefined | Promise<boolean | undefined>

export class InteractiveApprovalService implements ApprovalService {
  readonly #prompt: ApprovalPrompt

  constructor(prompt: ApprovalPrompt) {
    this.#prompt = prompt
  }

  async request(request: ApprovalRequest) {
    request.signal?.throwIfAborted()
    const presentation = snapshot({
      sessionId: request.sessionId,
      turnId: request.turnId,
      callId: request.callId,
      toolName: request.toolName,
      arguments: request.arguments,
      risk: request.risk,
      reason: request.reason,
    })
    try {
      const answer = await this.#prompt(presentation)
      if (request.signal?.aborted) return 'cancelled' as const
      return answer === true
        ? 'allowed-once' as const
        : answer === false ? 'rejected' as const : 'cancelled' as const
    } catch {
      if (request.signal?.aborted) return 'cancelled' as const
      return 'unavailable' as const
    }
  }
}

function operands(content: string): readonly [number, number] | undefined {
  const values = content.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
  return values[0] === undefined || values[1] === undefined
    ? undefined
    : [values[0], values[1]]
}

/** Deterministic multi-turn adapter used only by interactive replay mode. */
export class InteractiveReplayModelAdapter implements ModelAdapter {
  readonly id = 'calculator'
  readonly contextWindow?: number

  constructor(contextWindow?: number) {
    if (contextWindow !== undefined) this.contextWindow = contextWindow
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions = {},
  ): AsyncIterable<ModelStreamChunk> {
    options.signal?.throwIfAborted()
    const last = request.messages.at(-1)
    if (last?.role === 'user') {
      const values = operands(last.content)
      if (!values) {
        yield {
          type: 'finish', reason: 'completed',
          response: { type: 'message', content: 'Replay mode expects two numbers.' },
        }
        return
      }
      yield {
        type: 'finish',
        reason: 'completed',
        response: {
          type: 'tool_calls',
          calls: [{
            id: `${request.turnId}:add`,
            name: 'add',
            arguments: { a: values[0], b: values[1] },
          }],
        },
      }
      return
    }
    if (last?.role === 'tool' && last.name === 'add' && last.ok) {
      const content = `The answer is ${String(last.output)}.`
      yield { type: 'text-delta', delta: content }
      yield {
        type: 'finish', reason: 'completed',
        response: { type: 'message', content },
      }
      return
    }
    yield {
      type: 'finish', reason: 'error',
      error: 'interactive replay reached an unsupported conversation state',
    }
  }
}
