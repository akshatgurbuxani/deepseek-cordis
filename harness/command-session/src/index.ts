import type { CommandDefinition } from '@deepseek-cordis/commands'
import type { SessionCompactor } from '@deepseek-cordis/compaction'
import { deriveSessionSurface, type Session } from '@deepseek-cordis/session'

export interface SessionInspection {
  readonly id: string
  readonly events: number
  readonly turns: number
  readonly completedTurns: number
  readonly interruptedTurns: number
  readonly failedTurns: number
  readonly openTurn: boolean
  readonly surfaceMessages: number
  readonly compactions: number
  readonly lastSequence: number
}

export function inspectSession(session: Session): SessionInspection {
  const endings = session.events.filter((event) => event.type === 'turn/end')
  const starts = session.events.filter((event) => event.type === 'turn/start')
  return {
    id: session.id,
    events: session.events.length,
    turns: starts.length,
    completedTurns: endings.filter((event) => event.status === 'completed').length,
    interruptedTurns: endings.filter((event) => event.status === 'interrupted').length,
    failedTurns: endings.filter((event) => event.status === 'failed').length,
    openTurn: starts.length > endings.length,
    surfaceMessages: deriveSessionSurface(session.events).length,
    compactions: session.events.filter((event) => event.type === 'compaction/summary').length,
    lastSequence: session.events.at(-1)?.sequence ?? 0,
  }
}

export function formatSessionInspection(value: SessionInspection): string {
  return [
    `Session: ${value.id}`,
    `Events: ${value.events}`,
    `Turns: ${value.turns} (${value.completedTurns} completed, ${value.failedTurns} failed, ${value.interruptedTurns} interrupted)`,
    `Open turn: ${value.openTurn ? 'yes' : 'no'}`,
    `Model-visible messages: ${value.surfaceMessages}`,
    `Compactions: ${value.compactions}`,
    `Last sequence: ${value.lastSequence}`,
  ].join('\n')
}

export function createInspectCommand(): CommandDefinition {
  return {
    name: 'inspect',
    description: 'Inspect durable session state without contacting the model',
    handler: ({ session }) => ({
      kind: 'success',
      text: formatSessionInspection(inspectSession(session)),
    }),
  }
}

function parseRetainTurns(rawInput: string): number {
  const input = rawInput.trim()
  if (input.length === 0) return 1
  const value = Number(input)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('compact expects an optional positive integer retain-turn count')
  }
  return value
}

export function createCompactCommand(compactor: SessionCompactor): CommandDefinition {
  return {
    name: 'compact',
    description: 'Compact closed session history while retaining recent turns',
    inputHint: '[retain-turns]',
    async handler({ session, rawInput, signal }) {
      const result = await compactor.compact(session, {
        retainTurns: parseRetainTurns(rawInput),
        ...(signal ? { signal } : {}),
      })
      return result
        ? {
            kind: 'success',
            text: `Compacted ${result.shadowedSequences.length} model-visible messages at sequence ${result.event.sequence}.`,
            sourceSequence: result.event.sequence,
          }
        : { kind: 'success', text: 'No compactable history.' }
    },
  }
}
