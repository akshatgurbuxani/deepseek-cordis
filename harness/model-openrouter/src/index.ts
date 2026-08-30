import {
  completeModel,
  type ModelAdapter,
  type ModelCompletionOptions,
  ModelContextOverflowError,
  type ModelStreamOptions,
} from '@deepseek-cordis/model'
import {
  type JsonValue,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamChunk,
  snapshot,
  type ToolCall,
} from '@deepseek-cordis/protocol'

export interface OpenRouterDiagnostics {
  readonly requestedModel: string
  readonly selectedModel?: string
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
  readonly routerMetadata?: JsonValue
}

export interface OpenRouterAdapterOptions {
  readonly apiKey: string
  readonly model?: string
  readonly endpoint?: string
  readonly httpReferer?: string
  readonly appTitle?: string
  readonly fetch?: typeof globalThis.fetch
  readonly onDiagnostics?: (diagnostics: OpenRouterDiagnostics) => void
  readonly contextWindow?: number
}

export class OpenRouterRequestError extends Error {}

export class OpenRouterHttpError extends OpenRouterRequestError {
  readonly status: number
  readonly detail: string

  constructor(status: number, detail: string) {
    super(`OpenRouter request failed (${status}): ${detail || 'no response detail'}`)
    this.status = status
    this.detail = detail
  }
}

export class OpenRouterResponseError extends OpenRouterRequestError {}

interface WireToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly arguments: string
  }
}

type WireMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: null; readonly tool_calls: WireToolCall[] }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string }

function toWireMessage(message: ModelMessage): WireMessage {
  if (message.role === 'user') return message
  if (message.role === 'assistant' && 'content' in message) return message
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    }
  }
  return {
    role: 'tool',
    tool_call_id: message.callId,
    content: message.ok
      ? JSON.stringify(message.output)
      : JSON.stringify({ error: message.error }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean' || typeof value === 'string') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function readToolCall(value: unknown): ToolCall {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || value.type !== 'function'
    || !isRecord(value.function)
  ) {
    throw new OpenRouterResponseError('OpenRouter returned an invalid tool call')
  }
  const fn = value.function
  if (typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
    throw new OpenRouterResponseError('OpenRouter returned an invalid tool function')
  }

  let argumentsValue: unknown
  try {
    argumentsValue = JSON.parse(fn.arguments)
  } catch {
    throw new OpenRouterResponseError(
      `OpenRouter returned invalid JSON arguments for tool ${JSON.stringify(fn.name)}`,
    )
  }
  if (!isJsonValue(argumentsValue)) {
    throw new OpenRouterResponseError(
      `OpenRouter returned non-JSON arguments for tool ${JSON.stringify(fn.name)}`,
    )
  }
  return { id: value.id, name: fn.name, arguments: argumentsValue }
}

function optionalNumber(record: Record<string, unknown>, name: string): number | undefined {
  return typeof record[name] === 'number' ? record[name] : undefined
}

function isContextOverflow(status: number, detail: string): boolean {
  return (status === 400 || status === 413) && (
    /context[_ -]?(?:length|window)|maximum context|too many (?:input )?tokens/i.test(detail)
  )
}

async function* readSsePayloads(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  try {
    while (!done) {
      const result = await reader.read()
      done = result.done
      buffer += decoder.decode(result.value, { stream: !done })
      buffer = buffer.replaceAll('\r\n', '\n')
      if (done) buffer += '\n\n'

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data === '[DONE]') return
        if (data) {
          try {
            yield JSON.parse(data)
          } catch (error) {
            throw new OpenRouterResponseError('OpenRouter returned invalid streaming JSON', {
              cause: error,
            })
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    try { await reader.cancel() } catch {}
    reader.releaseLock()
  }
}

interface PartialToolCall {
  id: string
  name: string
  arguments: string
}

function applyToolCallDelta(calls: Map<number, PartialToolCall>, value: unknown): void {
  if (!isRecord(value) || !Number.isInteger(value.index) || Number(value.index) < 0) {
    throw new OpenRouterResponseError('OpenRouter returned an invalid streaming tool call')
  }
  const index = Number(value.index)
  const call = calls.get(index) ?? { id: '', name: '', arguments: '' }
  if (value.id !== undefined) {
    if (typeof value.id !== 'string') {
      throw new OpenRouterResponseError('OpenRouter returned an invalid streaming tool call id')
    }
    call.id += value.id
  }
  if (value.type !== undefined && value.type !== 'function') {
    throw new OpenRouterResponseError('OpenRouter returned an invalid streaming tool call type')
  }
  if (value.function !== undefined) {
    if (!isRecord(value.function)) {
      throw new OpenRouterResponseError('OpenRouter returned an invalid streaming tool function')
    }
    if (value.function.name !== undefined) {
      if (typeof value.function.name !== 'string') {
        throw new OpenRouterResponseError('OpenRouter returned an invalid streaming tool name')
      }
      call.name += value.function.name
    }
    if (value.function.arguments !== undefined) {
      if (typeof value.function.arguments !== 'string') {
        throw new OpenRouterResponseError('OpenRouter returned invalid streaming tool arguments')
      }
      call.arguments += value.function.arguments
    }
  }
  calls.set(index, call)
}

export class OpenRouterModelAdapter implements ModelAdapter {
  readonly id: string
  readonly contextWindow?: number
  readonly #apiKey: string
  readonly #model: string
  readonly #endpoint: string
  readonly #httpReferer: string | undefined
  readonly #appTitle: string | undefined
  readonly #fetch: typeof globalThis.fetch
  readonly #onDiagnostics: ((diagnostics: OpenRouterDiagnostics) => void) | undefined

  constructor(options: OpenRouterAdapterOptions) {
    if (!options.apiKey) throw new OpenRouterRequestError('OpenRouter API key is required')
    this.#apiKey = options.apiKey
    this.#model = options.model ?? 'openrouter/free'
    this.#endpoint = options.endpoint ?? 'https://openrouter.ai/api/v1/chat/completions'
    this.#httpReferer = options.httpReferer
    this.#appTitle = options.appTitle
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#onDiagnostics = options.onDiagnostics
    if (
      options.contextWindow !== undefined
      && (!Number.isInteger(options.contextWindow) || options.contextWindow < 1)
    ) throw new OpenRouterRequestError('OpenRouter context window must be a positive integer')
    if (options.contextWindow !== undefined) this.contextWindow = options.contextWindow
    this.id = `openrouter:${this.#model}`
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      'Content-Type': 'application/json',
      'X-OpenRouter-Metadata': 'enabled',
    }
    if (this.#httpReferer) headers['HTTP-Referer'] = this.#httpReferer
    if (this.#appTitle) headers['X-OpenRouter-Title'] = this.#appTitle
    return headers
  }

  #body(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const wireTools = request.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }))
    const body = {
      model: this.#model,
      messages: request.messages.map(toWireMessage),
      session_id: request.sessionId,
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...(wireTools.length === 0 ? {} : {
        tools: wireTools,
        tool_choice: 'auto' as const,
        parallel_tool_calls: false,
      }),
    }
    return body
  }

  async #fetchResponse(
    request: ModelRequest,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    signal?.throwIfAborted()
    let response: Response
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(this.#body(request, stream)),
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      signal?.throwIfAborted()
      const message = error instanceof Error ? error.message : String(error)
      throw new OpenRouterRequestError(`OpenRouter network request failed: ${message}`, {
        cause: error,
      })
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000)
      if (isContextOverflow(response.status, detail)) {
        throw new ModelContextOverflowError(detail || 'OpenRouter context window exceeded')
      }
      throw new OpenRouterHttpError(response.status, detail || response.statusText)
    }
    return response
  }

  #emitDiagnostics(payload: Record<string, unknown>): void {
    const usage = isRecord(payload.usage) ? payload.usage : {}
    const promptTokens = optionalNumber(usage, 'prompt_tokens')
    const completionTokens = optionalNumber(usage, 'completion_tokens')
    const totalTokens = optionalNumber(usage, 'total_tokens')
    const routerMetadata = isJsonValue(payload.openrouter_metadata)
      ? payload.openrouter_metadata
      : undefined
    this.#onDiagnostics?.(snapshot({
      requestedModel: this.#model,
      ...(typeof payload.model === 'string' ? { selectedModel: payload.model } : {}),
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(routerMetadata === undefined ? {} : { routerMetadata }),
    }))
  }

  async complete(
    request: ModelRequest,
    options: ModelCompletionOptions = {},
  ): Promise<ModelResponse> {
    if (options.onTextDelta) return completeModel(this, request, options)
    const response = await this.#fetchResponse(request, false, options.signal)
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new OpenRouterResponseError('OpenRouter returned invalid JSON', { cause: error })
    }
    if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
      throw new OpenRouterResponseError('OpenRouter returned an invalid completion response')
    }
    const choice = payload.choices[0]
    if (!isRecord(choice.message)) {
      throw new OpenRouterResponseError('OpenRouter completion did not contain a message')
    }
    const message = choice.message

    this.#emitDiagnostics(payload)

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return snapshot({ type: 'tool_calls', calls: message.tool_calls.map(readToolCall) })
    }
    if (typeof message.content === 'string') {
      return snapshot({ type: 'message', content: message.content })
    }
    throw new OpenRouterResponseError(
      'OpenRouter completion contained neither text nor tool calls',
    )
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions = {},
  ): AsyncIterable<ModelStreamChunk> {
    const text: string[] = []
    const toolCalls = new Map<number, PartialToolCall>()
    let diagnostics: Record<string, unknown> = {}
    let sawChoice = false
    try {
      const response = await this.#fetchResponse(request, true, options.signal)
      if (!response.body) throw new OpenRouterResponseError('OpenRouter stream has no body')

      for await (const value of readSsePayloads(response.body)) {
        options.signal?.throwIfAborted()
        if (!isRecord(value)) {
          throw new OpenRouterResponseError('OpenRouter returned an invalid streaming response')
        }
        if (isRecord(value.error)) {
          const message = typeof value.error.message === 'string'
            ? value.error.message
            : 'OpenRouter stream failed'
          if (
            value.error.code === 'context_length_exceeded'
            || value.error.code === 'context_window_exceeded'
            || isContextOverflow(400, message)
          ) throw new ModelContextOverflowError(message)
          throw new OpenRouterResponseError(message)
        }
        diagnostics = { ...diagnostics, ...value }
        if (!Array.isArray(value.choices) || value.choices.length === 0) continue
        sawChoice = true
        const choice = value.choices[0]
        if (!isRecord(choice) || !isRecord(choice.delta)) {
          throw new OpenRouterResponseError('OpenRouter returned an invalid streaming choice')
        }
        const delta = choice.delta
        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== 'string') {
            throw new OpenRouterResponseError('OpenRouter returned invalid streaming text')
          }
          if (delta.content) {
            text.push(delta.content)
            yield snapshot({ type: 'text-delta', delta: delta.content })
          }
        }
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) {
            throw new OpenRouterResponseError('OpenRouter returned invalid streaming tool calls')
          }
          delta.tool_calls.forEach((call) => applyToolCallDelta(toolCalls, call))
        }
      }

      options.signal?.throwIfAborted()
      if (!sawChoice) {
        throw new OpenRouterResponseError('OpenRouter stream contained no completion choice')
      }
      this.#emitDiagnostics(diagnostics)
      if (toolCalls.size > 0) {
        const calls = [...toolCalls.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, call]) => readToolCall({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          }))
        yield snapshot({
          type: 'finish',
          reason: 'completed',
          response: { type: 'tool_calls', calls },
        })
      } else {
        yield snapshot({
          type: 'finish',
          reason: 'completed',
          response: { type: 'message', content: text.join('') },
        })
      }
    } catch (error) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: 'aborted' }
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      yield {
        type: 'finish',
        reason: 'error',
        error: message,
        ...(error instanceof ModelContextOverflowError
          ? { code: 'context_window_exceeded' as const }
          : {}),
      }
    }
  }
}
