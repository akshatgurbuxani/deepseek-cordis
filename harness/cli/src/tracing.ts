import type { ModelAdapter } from '@deepseek-cordis/model'
import type { ModelRequest, ModelResponse, SessionEvent, SessionEventInput } from '@deepseek-cordis/protocol'
import {
  InMemorySession,
  type Session,
  type SessionStore,
} from '@deepseek-cordis/session'
import {
  RuntimeFiberState,
  type RuntimeContext,
} from '@deepseek-cordis/runtime-cordis'

export type TraceSink = (label: string, value: unknown) => void

export const consoleTrace: TraceSink = (label, value) => {
  console.log(`\n[${label}]`)
  console.dir(value, { colors: process.stdout.isTTY, depth: null })
}

class TracingSession extends InMemorySession {
  readonly #trace: TraceSink

  constructor(id: string, trace: TraceSink) {
    super(id)
    this.#trace = trace
  }

  override append(input: SessionEventInput): SessionEvent {
    const event = super.append(input)
    this.#trace('session/event', event)
    return event
  }
}

export class TracingSessionStore implements SessionStore {
  readonly #sessions = new Map<string, Session>()
  readonly #trace: TraceSink

  constructor(trace: TraceSink = consoleTrace) {
    this.#trace = trace
  }

  create(id: string): Session {
    if (this.#sessions.has(id)) {
      throw new Error(`session ${JSON.stringify(id)} already exists`)
    }
    const session = new TracingSession(id, this.#trace)
    this.#sessions.set(id, session)
    return session
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id)
  }
}

export class TracingModelAdapter implements ModelAdapter {
  readonly id: string
  readonly #inner: ModelAdapter
  readonly #trace: TraceSink

  constructor(inner: ModelAdapter, trace: TraceSink = consoleTrace) {
    this.#inner = inner
    this.#trace = trace
    this.id = `trace:${inner.id}`
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.#trace('model/request', request)
    const response = await this.#inner.complete(request)
    this.#trace('model/response', response)
    return response
  }
}

function stateName(state: number): string {
  switch (state) {
    case RuntimeFiberState.PENDING: return 'PENDING'
    case RuntimeFiberState.LOADING: return 'LOADING'
    case RuntimeFiberState.ACTIVE: return 'ACTIVE'
    case RuntimeFiberState.FAILED: return 'FAILED'
    case RuntimeFiberState.DISPOSED: return 'DISPOSED'
    case RuntimeFiberState.UNLOADING: return 'UNLOADING'
    default: return `UNKNOWN(${state})`
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
  return () => { dispose() }
}
