import type { ModelAdapter } from '@deepseek-cordis/model'
import type { ModelRequest, ModelResponse, SessionEvent, SessionEventInput } from '@deepseek-cordis/protocol'
import { InMemorySessionStore, type Session, type SessionStore } from '@deepseek-cordis/session'
import {
  RuntimeFiberState,
  type RuntimeContext,
} from '@deepseek-cordis/runtime-cordis'

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

  append(input: SessionEventInput): SessionEvent {
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
