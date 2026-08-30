import type {
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
} from '@deepseek-cordis/protocol'

export interface ModelStreamOptions {
  readonly signal?: AbortSignal
}

export interface ModelCompletionOptions extends ModelStreamOptions {
  readonly onTextDelta?: (delta: string) => void
}

export interface ModelAdapter {
  readonly id: string
  stream(
    request: ModelRequest,
    options?: ModelStreamOptions,
  ): AsyncIterable<ModelStreamChunk>
}

export class ModelStreamError extends Error {}

export class ModelStreamAbortedError extends ModelStreamError {
  constructor() {
    super('model stream aborted')
    this.name = 'ModelStreamAbortedError'
  }
}

export class ModelStreamProtocolError extends ModelStreamError {}

export async function completeModel(
  adapter: ModelAdapter,
  request: ModelRequest,
  options: ModelCompletionOptions = {},
): Promise<ModelResponse> {
  let finish: Extract<ModelStreamChunk, { type: 'finish' }> | undefined
  let streamedText = ''

  for await (const chunk of adapter.stream(request, {
    ...(options.signal ? { signal: options.signal } : {}),
  })) {
    if (finish) throw new ModelStreamProtocolError('model stream emitted a chunk after finish')
    if (chunk.type === 'text-delta') {
      streamedText += chunk.delta
      options.onTextDelta?.(chunk.delta)
    } else {
      finish = chunk
    }
  }

  if (!finish) throw new ModelStreamProtocolError('model stream ended without finish')
  if (finish.reason === 'error') throw new ModelStreamError(finish.error)
  if (finish.reason === 'aborted') throw new ModelStreamAbortedError()

  if (finish.response.type === 'message') {
    if (streamedText && streamedText !== finish.response.content) {
      throw new ModelStreamProtocolError('model text deltas do not match the completed message')
    }
  } else if (streamedText) {
    throw new ModelStreamProtocolError('model stream mixed text deltas with tool calls')
  }
  return finish.response
}
