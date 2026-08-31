import type { Component } from '../../004-context-isolation/src/runtime.ts'
import { service } from '../../004-context-isolation/src/runtime.ts'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: JsonValue
}

interface EventBase {
  readonly sequence: number
  readonly turnId: string
}

export type SessionEvent =
  | (EventBase & { readonly type: 'turn/start' })
  | (EventBase & { readonly type: 'user/message'; readonly content: string })
  | (EventBase & { readonly type: 'step/start'; readonly step: number })
  | (EventBase & {
      readonly type: 'assistant/tool-calls'
      readonly calls: readonly ToolCall[]
    })
  | (EventBase & { readonly type: 'tool/call'; readonly call: ToolCall })
  | (EventBase & {
      readonly type: 'tool/result'
      readonly callId: string
      readonly name: string
      readonly ok: true
      readonly output: JsonValue
    })
  | (EventBase & {
      readonly type: 'tool/result'
      readonly callId: string
      readonly name: string
      readonly ok: false
      readonly error: string
    })
  | (EventBase & { readonly type: 'assistant/message'; readonly content: string })
  | (EventBase & {
      readonly type: 'step/end'
      readonly step: number
      readonly outcome: 'tool_calls' | 'completed' | 'failed'
    })
  | (EventBase & { readonly type: 'turn/error'; readonly error: string })
  | (EventBase & { readonly type: 'turn/end'; readonly status: 'completed' | 'failed' })

export type SessionEventInput = SessionEvent extends infer Event
  ? Event extends { sequence: number }
    ? Omit<Event, 'sequence'>
    : never
  : never

export type ModelMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string }
  | { readonly role: 'assistant'; readonly toolCalls: readonly ToolCall[] }
  | {
      readonly role: 'tool'
      readonly callId: string
      readonly name: string
      readonly ok: true
      readonly output: JsonValue
    }
  | {
      readonly role: 'tool'
      readonly callId: string
      readonly name: string
      readonly ok: false
      readonly error: string
    }

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function snapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

export class Session {
  readonly id: string
  readonly #events: SessionEvent[] = []

  constructor(id: string) {
    this.id = id
  }

  get events(): readonly SessionEvent[] {
    return [...this.#events]
  }

  append(input: SessionEventInput): SessionEvent {
    const event = snapshot({ ...input, sequence: this.#events.length + 1 }) as SessionEvent
    this.#events.push(event)
    return event
  }

  projectMessages(): readonly ModelMessage[] {
    return this.#events.flatMap((event): ModelMessage[] => {
      switch (event.type) {
        case 'user/message':
          return [{ role: 'user', content: event.content }]
        case 'assistant/message':
          return [{ role: 'assistant', content: event.content }]
        case 'assistant/tool-calls':
          return [{ role: 'assistant', toolCalls: event.calls }]
        case 'tool/result':
          return event.ok
            ? [
                {
                  role: 'tool',
                  callId: event.callId,
                  name: event.name,
                  ok: true,
                  output: event.output,
                },
              ]
            : [
                {
                  role: 'tool',
                  callId: event.callId,
                  name: event.name,
                  ok: false,
                  error: event.error,
                },
              ]
        default:
          return []
      }
    })
  }
}

export class SessionStore {
  readonly #sessions = new Map<string, Session>()

  create(id: string): Session {
    if (this.#sessions.has(id)) {
      throw new Error(`session ${JSON.stringify(id)} already exists`)
    }
    const session = new Session(id)
    this.#sessions.set(id, session)
    return session
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id)
  }
}

export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonValue
}

export interface ToolDefinition extends ToolSchema {
  readonly execute: (argumentsValue: JsonValue) => JsonValue | Promise<JsonValue>
}

export type ToolExecution =
  | { readonly ok: true; readonly output: JsonValue }
  | { readonly ok: false; readonly error: string }

export class ToolRegistry {
  readonly #definitions = new Map<string, ToolDefinition>()

  get size(): number {
    return this.#definitions.size
  }

  register(definition: ToolDefinition): () => void {
    if (this.#definitions.has(definition.name)) {
      throw new Error(`tool ${JSON.stringify(definition.name)} is already registered`)
    }
    this.#definitions.set(definition.name, definition)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.#definitions.get(definition.name) === definition) {
        this.#definitions.delete(definition.name)
      }
    }
  }

  schemas(): readonly ToolSchema[] {
    return [...this.#definitions.values()].map(({ name, description, inputSchema }) =>
      snapshot({ name, description, inputSchema }),
    )
  }

  async execute(name: string, argumentsValue: JsonValue): Promise<ToolExecution> {
    const definition = this.#definitions.get(name)
    if (!definition) return { ok: false, error: `tool ${JSON.stringify(name)} is not registered` }
    try {
      return { ok: true, output: snapshot(await definition.execute(snapshot(argumentsValue))) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

export interface ModelRequest {
  readonly sessionId: string
  readonly turnId: string
  readonly step: number
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ToolSchema[]
}

export type ModelResponse =
  | { readonly type: 'message'; readonly content: string }
  | { readonly type: 'tool_calls'; readonly calls: readonly ToolCall[] }

export interface ModelAdapter {
  readonly id: string
  complete(request: ModelRequest): Promise<ModelResponse>
}

export class ReplayModelAdapter implements ModelAdapter {
  readonly id: string
  readonly requests: ModelRequest[] = []
  readonly #responses: ModelResponse[]

  constructor(id: string, responses: readonly ModelResponse[]) {
    this.id = id
    this.#responses = responses.map((response) => snapshot(response))
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(snapshot(request))
    const response = this.#responses.shift()
    if (!response) throw new Error(`replay adapter ${JSON.stringify(this.id)} exhausted`)
    return snapshot(response)
  }
}

export interface RunOptions {
  readonly maxSteps?: number
}

export interface RunResult {
  readonly turnId: string
  readonly content: string
  readonly steps: number
}

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
      disposed = true
      if (this.#running.size > 0) {
        throw new Error('cannot disconnect the agent loop while a turn is running')
      }
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
          response = await model.complete(
            snapshot({
              sessionId: session.id,
              turnId,
              step,
              messages: session.projectMessages(),
              tools: tools.schemas(),
            }),
          )
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
          session.append(
            execution.ok
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
                },
          )
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

export const sessionsService = service<SessionStore>('sessions')
export const toolsService = service<ToolRegistry>('tools')
export const modelService = service<ModelAdapter>('model')
export const agentLoopService = service<AgentLoop>('agentLoop')
const toolOwnershipKeys = new Map<string, ReturnType<typeof service<true>>>()

function toolOwnershipKey(name: string): ReturnType<typeof service<true>> {
  let key = toolOwnershipKeys.get(name)
  if (!key) {
    key = service<true>(`tool:${name}`)
    toolOwnershipKeys.set(name, key)
  }
  return key
}

export function sessionPlugin(name = 'sessions'): Component {
  const store = new SessionStore()
  return { name, provides: [[sessionsService, store]], setup() {} }
}

export function toolRegistryPlugin(name = 'tools'): Component {
  const registry = new ToolRegistry()
  return { name, provides: [[toolsService, registry]], setup() {} }
}

export function toolPlugin(definition: ToolDefinition): Component {
  const ownership = toolOwnershipKey(definition.name)
  return {
    name: `tool:${definition.name}`,
    requires: [toolsService],
    provides: [[ownership, true]],
    setup(context) {
      return context.effect(() => context.get(toolsService).register(definition))
    },
  }
}

export function modelPlugin(adapter: ModelAdapter): Component {
  return {
    name: `model:${adapter.id}`,
    provides: [[modelService, adapter]],
    setup() {},
  }
}

export function agentLoopPlugin(name = 'agent-loop'): Component {
  const loop = new AgentLoop()
  return {
    name,
    requires: [sessionsService, toolsService, modelService],
    provides: [[agentLoopService, loop]],
    setup(context) {
      return context.effect(() =>
        loop.connect(
          context.get(sessionsService),
          context.get(toolsService),
          context.get(modelService),
        ),
      )
    },
  }
}
