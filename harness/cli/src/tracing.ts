import {
  completeModel,
  type ModelAdapter,
  type ModelCompletionOptions,
  type ModelInfo,
  type ModelStreamOptions,
} from '@deepseek-cordis/model'
import type {
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
  SessionEvent,
  SessionEventInput,
} from '@deepseek-cordis/protocol'
import { type RuntimeContext, RuntimeFiberState } from '@deepseek-cordis/runtime-cordis'
import {
  type AppendedSessionEvent,
  InMemorySessionStore,
  type Session,
  type SessionStore,
} from '@deepseek-cordis/session'

export type TraceSink = (label: string, value: unknown) => void

export const consoleTrace: TraceSink = (label, value) => {
  console.log(`\n[${label}]`)
  console.dir(value, { colors: process.stdout.isTTY, depth: null })
}

class TracingSession implements Session {
  readonly #inner: Session
  readonly #trace: TraceSink

  constructor(inner: Session, trace: TraceSink) {
    this.#inner = inner
    this.#trace = trace
  }

  get id(): string {
    return this.#inner.id
  }

  get events(): readonly SessionEvent[] {
    return this.#inner.events
  }

  append<const Input extends SessionEventInput>(input: Input): AppendedSessionEvent<Input> {
    const event = this.#inner.append(input)
    this.#trace('session/event', event)
    return event
  }

  projectMessages() {
    return this.#inner.projectMessages()
  }
}

export class TracingSessionStore implements SessionStore {
  readonly #inner: SessionStore
  readonly #sessions = new Map<string, { readonly inner: Session; readonly traced: Session }>()
  readonly #trace: TraceSink

  constructor(trace: TraceSink = consoleTrace, inner: SessionStore = new InMemorySessionStore()) {
    this.#trace = trace
    this.#inner = inner
  }

  create(id: string): Session {
    return this.#wrap(this.#inner.create(id))
  }

  get(id: string): Session | undefined {
    const session = this.#inner.get(id)
    return session === undefined ? undefined : this.#wrap(session)
  }

  #wrap(inner: Session): Session {
    const cached = this.#sessions.get(inner.id)
    if (cached?.inner === inner) return cached.traced
    const traced = new TracingSession(inner, this.#trace)
    this.#sessions.set(inner.id, { inner, traced })
    return traced
  }
}

export class TracingModelAdapter implements ModelAdapter {
  readonly id: string
  readonly contextWindow?: number
  readonly #inner: ModelAdapter
  readonly #trace: TraceSink

  constructor(inner: ModelAdapter, trace: TraceSink = consoleTrace) {
    this.#inner = inner
    this.#trace = trace
    this.id = `trace:${inner.id}`
    if (inner.contextWindow !== undefined) this.contextWindow = inner.contextWindow
  }

  async resolveInfo(options: ModelStreamOptions = {}): Promise<ModelInfo> {
    try {
      const info = this.#inner.resolveInfo
        ? await this.#inner.resolveInfo(options)
        : {
            model: this.#inner.id,
            ...(this.#inner.contextWindow === undefined
              ? {}
              : { contextWindow: this.#inner.contextWindow }),
          }
      this.#trace('model/info', info)
      return info
    } catch (error) {
      this.#trace('model/info-error', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions = {},
  ): AsyncIterable<ModelStreamChunk> {
    this.#trace('model/request', request)
    for await (const chunk of this.#inner.stream(request, options)) {
      this.#trace('model/stream', chunk)
      if (chunk.type === 'finish' && chunk.reason === 'completed') {
        this.#trace('model/response', chunk.response)
      }
      yield chunk
    }
  }

  async complete(
    request: ModelRequest,
    options: ModelCompletionOptions = {},
  ): Promise<ModelResponse> {
    return completeModel(this, request, options)
  }
}

function stateName(state: number): string {
  switch (state) {
    case RuntimeFiberState.PENDING:
      return 'PENDING'
    case RuntimeFiberState.LOADING:
      return 'LOADING'
    case RuntimeFiberState.ACTIVE:
      return 'ACTIVE'
    case RuntimeFiberState.FAILED:
      return 'FAILED'
    case RuntimeFiberState.DISPOSED:
      return 'DISPOSED'
    case RuntimeFiberState.UNLOADING:
      return 'UNLOADING'
    default:
      return `UNKNOWN(${state})`
  }
}

export function traceRuntimeLifecycle(
  context: RuntimeContext,
  trace: TraceSink = consoleTrace,
): () => void {
  const dispose = context.on('internal/status', (fiber, previous) => {
    trace('runtime/fiber', {
      name: fiber.name,
      from: stateName(previous),
      to: stateName(fiber.state),
    })
  })
  return () => {
    dispose()
  }
}
