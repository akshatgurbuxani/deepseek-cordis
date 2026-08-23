import type {
  JsonValue,
  ModelAdapter,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from '../../006-minimal-harness-slice/src/harness.ts'

export interface OpenRouterUsage {
  readonly requestedModel: string
  readonly selectedModel?: string
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
}

export interface OpenRouterAdapterOptions {
  readonly apiKey: string
  readonly model?: string
  readonly endpoint?: string
  readonly httpReferer?: string
  readonly appTitle?: string
  readonly fetch?: typeof globalThis.fetch
  readonly onUsage?: (usage: OpenRouterUsage) => void
}

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
  if (['boolean', 'number', 'string'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function readToolCall(value: unknown): ToolCall {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.function)) {
    throw new Error('OpenRouter returned an invalid tool call')
  }
  const fn = value.function
  if (typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
    throw new Error('OpenRouter returned an invalid tool function')
  }

  let argumentsValue: unknown
  try {
    argumentsValue = JSON.parse(fn.arguments)
  } catch {
    throw new Error(`OpenRouter returned invalid JSON arguments for tool ${JSON.stringify(fn.name)}`)
  }
  if (!isJsonValue(argumentsValue)) {
    throw new Error(`OpenRouter returned non-JSON arguments for tool ${JSON.stringify(fn.name)}`)
  }
  return { id: value.id, name: fn.name, arguments: argumentsValue }
}

function optionalNumber(record: Record<string, unknown>, name: string): number | undefined {
  return typeof record[name] === 'number' ? record[name] : undefined
}

export class OpenRouterModelAdapter implements ModelAdapter {
  readonly id: string
  readonly #apiKey: string
  readonly #model: string
  readonly #endpoint: string
  readonly #httpReferer: string | undefined
  readonly #appTitle: string | undefined
  readonly #fetch: typeof globalThis.fetch
  readonly #onUsage: ((usage: OpenRouterUsage) => void) | undefined

  constructor(options: OpenRouterAdapterOptions) {
    if (!options.apiKey) throw new Error('OpenRouter API key is required')
    this.#apiKey = options.apiKey
    this.#model = options.model ?? 'openrouter/free'
    this.#endpoint = options.endpoint ?? 'https://openrouter.ai/api/v1/chat/completions'
    this.#httpReferer = options.httpReferer
    this.#appTitle = options.appTitle
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#onUsage = options.onUsage
    this.id = `openrouter:${this.#model}`
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      'Content-Type': 'application/json',
      'X-OpenRouter-Metadata': 'enabled',
    }
    if (this.#httpReferer) headers['HTTP-Referer'] = this.#httpReferer
    if (this.#appTitle) headers['X-Title'] = this.#appTitle

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
      ...(wireTools.length === 0 ? {} : {
        tools: wireTools,
        tool_choice: 'auto' as const,
        parallel_tool_calls: false,
      }),
    }
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000)
      if (
        response.status === 404 &&
        /guardrail restrictions and data policy/i.test(detail)
      ) {
        throw new Error(
          `OpenRouter could not route model ${JSON.stringify(this.#model)} because no endpoint satisfies ` +
          'the account/API-key privacy and guardrail policy. Review Settings > Privacy: ZDR for ' +
          'non-frontier models, provider data-collection/training policy, and model/provider allowlists. ' +
          `Original response: ${detail}`,
        )
      }
      throw new Error(`OpenRouter request failed (${response.status}): ${detail || response.statusText}`)
    }

    const payload: unknown = await response.json()
    if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
      throw new Error('OpenRouter returned an invalid completion response')
    }
    const choice = payload.choices[0]
    if (!isRecord(choice.message)) {
      throw new Error('OpenRouter completion did not contain a message')
    }
    const message = choice.message

    const usage = isRecord(payload.usage) ? payload.usage : {}
    const promptTokens = optionalNumber(usage, 'prompt_tokens')
    const completionTokens = optionalNumber(usage, 'completion_tokens')
    const totalTokens = optionalNumber(usage, 'total_tokens')
    this.#onUsage?.({
      requestedModel: this.#model,
      ...(typeof payload.model === 'string' ? { selectedModel: payload.model } : {}),
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
    })

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return { type: 'tool_calls', calls: message.tool_calls.map(readToolCall) }
    }
    if (typeof message.content === 'string') {
      return { type: 'message', content: message.content }
    }
    throw new Error('OpenRouter completion contained neither text nor tool calls')
  }
}
