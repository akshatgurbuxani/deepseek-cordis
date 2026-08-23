import {
  type ModelMessage,
  type SessionEvent,
  type SessionEventInput,
  snapshot,
} from '@deepseek-cordis/protocol'

export interface Session {
  readonly id: string
  readonly events: readonly SessionEvent[]
  append(input: SessionEventInput): SessionEvent
  projectMessages(): readonly ModelMessage[]
}

export interface SessionStore {
  create(id: string): Session
  get(id: string): Session | undefined
}

export class InMemorySession implements Session {
  readonly id: string
  readonly #events: SessionEvent[] = []

  constructor(id: string) {
    this.id = id
  }

  get events(): readonly SessionEvent[] {
    return [...this.#events]
  }

  append(input: SessionEventInput): SessionEvent {
    const event = snapshot({
      ...input,
      sequence: this.#events.length + 1,
    }) as SessionEvent
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
            ? [{
                role: 'tool',
                callId: event.callId,
                name: event.name,
                ok: true,
                output: event.output,
              }]
            : [{
                role: 'tool',
                callId: event.callId,
                name: event.name,
                ok: false,
                error: event.error,
              }]
        default:
          return []
      }
    })
  }
}

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, Session>()

  create(id: string): Session {
    if (this.#sessions.has(id)) {
      throw new Error(`session ${JSON.stringify(id)} already exists`)
    }
    const session = new InMemorySession(id)
    this.#sessions.set(id, session)
    return session
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id)
  }
}
