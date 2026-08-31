import {
  type ModelRequest,
  type ModelResponse,
  type ModelStreamChunk,
  snapshot,
} from '@deepseek-cordis/protocol'

import {
  completeModel,
  type ModelAdapter,
  type ModelCompletionOptions,
  type ModelStreamOptions,
} from './index.js'

export class ReplayModelAdapter implements ModelAdapter {
  readonly id: string
  readonly contextWindow?: number
  readonly requests: ModelRequest[] = []
  readonly #responses: ModelResponse[]

  constructor(
    id: string,
    responses: readonly ModelResponse[],
    options: { readonly contextWindow?: number } = {},
  ) {
    this.id = id
    if (options.contextWindow !== undefined) {
      if (!Number.isInteger(options.contextWindow) || options.contextWindow < 1) {
        throw new RangeError('contextWindow must be a positive integer')
      }
      this.contextWindow = options.contextWindow
    }
    this.#responses = responses.map((response) => snapshot(response))
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions = {},
  ): AsyncIterable<ModelStreamChunk> {
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: 'aborted' }
      return
    }
    this.requests.push(snapshot(request))
    const response = this.#responses.shift()
    if (!response) {
      yield {
        type: 'finish',
        reason: 'error',
        error: `replay adapter ${JSON.stringify(this.id)} exhausted`,
      }
      return
    }
    if (response.type === 'message') yield { type: 'text-delta', delta: response.content }
    yield options.signal?.aborted
      ? { type: 'finish', reason: 'aborted' }
      : { type: 'finish', reason: 'completed', response: snapshot(response) }
  }

  complete(request: ModelRequest, options: ModelCompletionOptions = {}): Promise<ModelResponse> {
    return completeModel(this, request, options)
  }
}
