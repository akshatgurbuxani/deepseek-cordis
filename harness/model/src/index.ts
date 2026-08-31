import type {
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
  ModelTokenUsage,
} from '@deepseek-cordis/protocol'

export interface ModelStreamOptions {
  readonly signal?: AbortSignal
}

export interface ModelCompletionOptions extends ModelStreamOptions {
  readonly onTextDelta?: (delta: string) => void
}

export interface ModelInfo {
  readonly model: string
  readonly contextWindow?: number
}

export interface ModelCompletionResult {
  readonly response: ModelResponse
  readonly usage?: ModelTokenUsage
}

export interface ModelAdapter {
  readonly id: string
  readonly contextWindow?: number
  resolveInfo?(options?: ModelStreamOptions): Promise<ModelInfo>
  stream(request: ModelRequest, options?: ModelStreamOptions): AsyncIterable<ModelStreamChunk>
}

export class ModelStreamError extends Error {
  readonly code: string | undefined

  constructor(message: string, options: ErrorOptions & { readonly code?: string } = {}) {
    super(message, options)
    this.code = options.code
  }
}

export class ModelContextOverflowError extends ModelStreamError {
  constructor(message = 'model context window exceeded', options: ErrorOptions = {}) {
    super(message, { ...options, code: 'context_window_exceeded' })
    this.name = 'ModelContextOverflowError'
  }
}

export class ModelStreamAbortedError extends ModelStreamError {
  constructor() {
    super('model stream aborted')
    this.name = 'ModelStreamAbortedError'
  }
}

export class ModelStreamProtocolError extends ModelStreamError {}

function validateUsage(usage: ModelTokenUsage | undefined): ModelTokenUsage | undefined {
  if (usage === undefined) return undefined
  if (
    !Number.isInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isInteger(usage.outputTokens) ||
    usage.outputTokens < 0
  )
    throw new ModelStreamProtocolError('model stream returned invalid token usage')
  return usage
}

function validateInfo(info: ModelInfo): ModelInfo {
  if (typeof info.model !== 'string' || info.model.trim().length === 0) {
    throw new Error('model info must contain a model id')
  }
  if (
    info.contextWindow !== undefined &&
    (!Number.isInteger(info.contextWindow) || info.contextWindow < 1)
  )
    throw new Error('model info contextWindow must be a positive integer')
  return info
}

export async function resolveModelInfo(
  adapter: ModelAdapter,
  options: ModelStreamOptions = {},
): Promise<ModelInfo> {
  options.signal?.throwIfAborted()
  const info = adapter.resolveInfo
    ? await adapter.resolveInfo(options)
    : {
        model: adapter.id,
        ...(adapter.contextWindow === undefined ? {} : { contextWindow: adapter.contextWindow }),
      }
  options.signal?.throwIfAborted()
  return validateInfo(info)
}

export async function completeModelResult(
  adapter: ModelAdapter,
  request: ModelRequest,
  options: ModelCompletionOptions = {},
): Promise<ModelCompletionResult> {
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
  if (finish.reason === 'error') {
    if (finish.code === 'context_window_exceeded') {
      throw new ModelContextOverflowError(finish.error)
    }
    throw new ModelStreamError(finish.error)
  }
  if (finish.reason === 'aborted') throw new ModelStreamAbortedError()

  if (finish.response.type === 'message') {
    if (streamedText && streamedText !== finish.response.content) {
      throw new ModelStreamProtocolError('model text deltas do not match the completed message')
    }
  } else if (streamedText) {
    throw new ModelStreamProtocolError('model stream mixed text deltas with tool calls')
  }
  const usage = validateUsage(finish.usage)
  return {
    response: finish.response,
    ...(usage === undefined ? {} : { usage }),
  }
}

export async function completeModel(
  adapter: ModelAdapter,
  request: ModelRequest,
  options: ModelCompletionOptions = {},
): Promise<ModelResponse> {
  return (await completeModelResult(adapter, request, options)).response
}
