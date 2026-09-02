import {
  type ModelMessage,
  type SessionEvent,
  type SessionEventInput,
  snapshot,
} from '@deepseek-cordis/protocol'

export interface Session {
  readonly id: string
  readonly events: readonly SessionEvent[]
  append<const Input extends SessionEventInput>(input: Input): AppendedSessionEvent<Input>
  projectMessages(): readonly ModelMessage[]
}

export type AppendedSessionEvent<Input extends SessionEventInput> = Extract<
  SessionEvent,
  { readonly type: Input['type'] }
>

export interface SessionStore {
  create(id: string): Session
  get(id: string): Session | undefined
  list(): readonly Session[]
}

export interface SessionSurfaceNode {
  readonly sequence: number
  readonly turnId: string
  readonly message: ModelMessage
}

export class SessionProjectionError extends Error {}

function validateUsageAnchor(
  event: Extract<SessionEvent, { readonly type: 'assistant/message' | 'assistant/tool-calls' }>,
  surface: readonly SessionSurfaceNode[],
): void {
  if (!event.usage) return
  const actual = surface.map((node) => node.sequence)
  if (
    actual.length !== event.usage.inputSurfaceSequences.length ||
    actual.some((sequence, index) => sequence !== event.usage?.inputSurfaceSequences[index])
  ) {
    throw new SessionProjectionError(
      `assistant usage event ${event.sequence} does not match its input surface`,
    )
  }
}

export function deriveSessionSurface(
  events: readonly SessionEvent[],
): readonly SessionSurfaceNode[] {
  const surface: SessionSurfaceNode[] = []
  const closedTurns = new Set<string>()
  let openTurn: string | undefined
  let openStep: number | undefined
  for (const event of events) {
    let message: ModelMessage | undefined
    switch (event.type) {
      case 'turn/start':
        openTurn = event.turnId
        break
      case 'turn/end':
        if (openTurn === event.turnId) openTurn = undefined
        closedTurns.add(event.turnId)
        break
      case 'step/start':
        openStep = event.step
        break
      case 'step/end':
        if (openStep === event.step) openStep = undefined
        break
      case 'user/message':
        message = { role: 'user', content: event.content }
        break
      case 'assistant/message':
        validateUsageAnchor(event, surface)
        message = { role: 'assistant', content: event.content }
        break
      case 'assistant/tool-calls':
        validateUsageAnchor(event, surface)
        message = { role: 'assistant', toolCalls: event.calls }
        break
      case 'tool/result':
        message = event.ok
          ? {
              role: 'tool',
              callId: event.callId,
              name: event.name,
              ok: true,
              output: event.output,
            }
          : {
              role: 'tool',
              callId: event.callId,
              name: event.name,
              ok: false,
              error: event.error,
            }
        break
      case 'compaction/summary': {
        if (openStep !== undefined || !closedTurns.has(event.turnId)) {
          throw new SessionProjectionError(
            `compaction event ${event.sequence} is not at a maintenance boundary`,
          )
        }
        const actual = surface.slice(0, event.shadowedSequences.length).map((node) => node.sequence)
        if (
          event.shadowedSequences.length === 0 ||
          actual.length !== event.shadowedSequences.length ||
          actual.some((sequence, index) => sequence !== event.shadowedSequences[index])
        ) {
          throw new SessionProjectionError(
            `compaction event ${event.sequence} does not shadow the current surface prefix`,
          )
        }
        const boundary = surface[event.shadowedSequences.length - 1]
        if (boundary?.turnId !== event.turnId) {
          throw new SessionProjectionError(
            `compaction event ${event.sequence} does not match its boundary turn`,
          )
        }
        surface.splice(0, actual.length, {
          sequence: event.sequence,
          turnId: event.turnId,
          message: { role: 'user', content: event.summary },
        })
        break
      }
      case 'context-budget/decision': {
        if (event.outcome === 'compacted') {
          const checkpoint = events[event.summarySequence - 1]
          if (checkpoint?.type !== 'compaction/summary') {
            throw new SessionProjectionError(
              `context budget decision ${event.sequence} does not reference a compaction event`,
            )
          }
        }
        break
      }
      default:
        break
    }
    if (message) {
      surface.push({ sequence: event.sequence, turnId: event.turnId, message })
    }
  }
  return surface
}

export function projectSessionMessages(events: readonly SessionEvent[]): readonly ModelMessage[] {
  return deriveSessionSurface(events).map((node) => node.message)
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

  append<const Input extends SessionEventInput>(input: Input): AppendedSessionEvent<Input> {
    const event = snapshot({
      ...input,
      sequence: this.#events.length + 1,
    }) as unknown as SessionEvent
    if (
      event.type === 'compaction/summary' ||
      event.type === 'context-budget/decision' ||
      ((event.type === 'assistant/message' || event.type === 'assistant/tool-calls') &&
        event.usage !== undefined)
    ) {
      deriveSessionSurface([...this.#events, event])
    }
    this.#events.push(event)
    return event as AppendedSessionEvent<Input>
  }

  projectMessages(): readonly ModelMessage[] {
    return projectSessionMessages(this.#events)
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

  list(): readonly Session[] {
    return [...this.#sessions.values()].sort((left, right) => left.id.localeCompare(right.id))
  }
}
