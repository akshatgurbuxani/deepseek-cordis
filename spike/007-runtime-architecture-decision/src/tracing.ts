import { type Context, FiberState } from 'cordis'

import {
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  Session,
  type SessionEvent,
  type SessionEventInput,
  SessionStore,
} from '../../006-minimal-harness-slice/src/harness.ts'

export type TraceSink = (label: string, value: unknown) => void

export const consoleTrace: TraceSink = (label, value) => {
  console.log(`\n[${label}]`)
  console.dir(value, { colors: process.stdout.isTTY, depth: null })
}

class TracingSession extends Session {
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

export class TracingSessionStore extends SessionStore {
  readonly #sessions = new Map<string, Session>()
  readonly #trace: TraceSink

  constructor(trace: TraceSink = consoleTrace) {
    super()
    this.#trace = trace
  }

  override create(id: string): Session {
    if (this.#sessions.has(id)) {
      throw new Error(`session ${JSON.stringify(id)} already exists`)
    }
    const session = new TracingSession(id, this.#trace)
    this.#sessions.set(id, session)
    return session
  }

  override get(id: string): Session | undefined {
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

function stateName(state: FiberState): string {
  switch (state) {
    case FiberState.PENDING:
      return 'PENDING'
    case FiberState.LOADING:
      return 'LOADING'
    case FiberState.ACTIVE:
      return 'ACTIVE'
    case FiberState.FAILED:
      return 'FAILED'
    case FiberState.DISPOSED:
      return 'DISPOSED'
    case FiberState.UNLOADING:
      return 'UNLOADING'
    default:
      return `UNKNOWN(${state})`
  }
}

export function traceCordisLifecycle(
  context: Context,
  trace: TraceSink = consoleTrace,
): () => boolean {
  return context.on('internal/status', (fiber, previous) => {
    trace('cordis/fiber', {
      name: fiber.name,
      from: stateName(previous),
      to: stateName(fiber.state),
    })
  })
}
