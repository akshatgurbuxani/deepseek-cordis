import {
  type CommandResult,
  snapshot,
} from '@deepseek-cordis/protocol'
import type { Session } from '@deepseek-cordis/session'

export interface CommandInvocation {
  readonly commandId: string
  readonly session: Session
  readonly rawInput: string
  readonly signal?: AbortSignal
}

export interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly inputHint?: string
  readonly handler: (
    invocation: CommandInvocation,
  ) => CommandResult | Promise<CommandResult>
}

export interface CommandDescriptor {
  readonly name: string
  readonly description: string
  readonly inputHint?: string
}

export interface ParsedCommand {
  readonly name: string
  readonly rawInput: string
}

export interface CommandExecution {
  readonly commandId: string
  readonly name: string
  readonly result: CommandResult
}

export interface CommandRegistry {
  readonly size: number
  register(definition: CommandDefinition): () => void
  list(): readonly CommandDescriptor[]
  find(name: string): CommandDescriptor | undefined
  execute(
    session: Session,
    line: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CommandExecution | undefined>
}

interface RegisteredCommand {
  readonly descriptor: CommandDescriptor
  readonly handler: CommandDefinition['handler']
}

const commandPattern = /^\/([a-z][a-z0-9_-]*)(?=$|\s)([\s\S]*)$/

export function parseCommand(line: string): ParsedCommand | undefined {
  const match = commandPattern.exec(line)
  if (!match) return undefined
  return snapshot({ name: match[1]!, rawInput: match[2]! })
}

function normalizeResult(value: unknown): CommandResult {
  if (value === null || typeof value !== 'object' || !('kind' in value)) {
    return { kind: 'error', text: 'command returned an invalid result' }
  }
  if (
    value.kind === 'success'
    && (!('text' in value) || value.text === undefined || typeof value.text === 'string')
    && (!('sourceSequence' in value)
      || value.sourceSequence === undefined
      || (Number.isInteger(value.sourceSequence) && Number(value.sourceSequence) > 0))
  ) {
    const text = 'text' in value && typeof value.text === 'string'
      ? value.text
      : undefined
    const sourceSequence = 'sourceSequence' in value
      && typeof value.sourceSequence === 'number'
      ? value.sourceSequence
      : undefined
    return snapshot({
      kind: 'success',
      ...(text === undefined ? {} : { text }),
      ...(sourceSequence === undefined ? {} : { sourceSequence }),
    })
  }
  if (value.kind === 'error' && 'text' in value && typeof value.text === 'string') {
    return snapshot({ kind: 'error', text: value.text })
  }
  return { kind: 'error', text: 'command returned an invalid result' }
}

export class InMemoryCommandRegistry implements CommandRegistry {
  readonly #commands = new Map<string, RegisteredCommand>()
  readonly #runningSessions = new WeakSet<Session>()

  get size(): number {
    return this.#commands.size
  }

  register(definition: CommandDefinition): () => void {
    if (!/^[a-z][a-z0-9_-]*$/.test(definition.name)) {
      throw new Error(`invalid command name ${JSON.stringify(definition.name)}`)
    }
    if (definition.description.trim().length === 0) {
      throw new Error(`command ${JSON.stringify(definition.name)} has an empty description`)
    }
    if (this.#commands.has(definition.name)) {
      throw new Error(`command ${JSON.stringify(definition.name)} is already registered`)
    }
    const descriptor = snapshot({
      name: definition.name,
      description: definition.description,
      ...(definition.inputHint === undefined ? {} : { inputHint: definition.inputHint }),
    })
    const registration = { descriptor, handler: definition.handler }
    this.#commands.set(definition.name, registration)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.#commands.get(definition.name) === registration) {
        this.#commands.delete(definition.name)
      }
    }
  }

  list(): readonly CommandDescriptor[] {
    return [...this.#commands.values()]
      .map(({ descriptor }) => snapshot(descriptor))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  find(name: string): CommandDescriptor | undefined {
    const descriptor = this.#commands.get(name)?.descriptor
    return descriptor ? snapshot(descriptor) : undefined
  }

  async execute(
    session: Session,
    line: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CommandExecution | undefined> {
    const parsed = parseCommand(line)
    if (!parsed) return undefined
    const definition = this.#commands.get(parsed.name)
    if (!definition) return undefined
    options.signal?.throwIfAborted()
    const openTurns = session.events.filter((event) => event.type === 'turn/start').length
      - session.events.filter((event) => event.type === 'turn/end').length
    if (openTurns !== 0) throw new Error('cannot run a command while a turn is open')
    if (this.#runningSessions.has(session)) {
      throw new Error('cannot run concurrent commands for one session')
    }
    this.#runningSessions.add(session)
    try {
      const commandNumber = session.events.filter((event) => event.type === 'command/run').length + 1
      const commandId = `${session.id}:command:${commandNumber}`
      session.append({
        type: 'command/run',
        turnId: commandId,
        commandId,
        name: parsed.name,
        rawInput: parsed.rawInput,
      })

      let result: CommandResult
      try {
        result = normalizeResult(await definition.handler({
          commandId,
          session,
          rawInput: parsed.rawInput,
          ...(options.signal ? { signal: options.signal } : {}),
        }))
        if (
          result.kind === 'success'
          && result.sourceSequence !== undefined
          && (
            result.sourceSequence >= session.events.length + 1
            || session.events[result.sourceSequence - 1]?.type === 'command/run'
            || session.events[result.sourceSequence - 1]?.type === 'command/done'
          )
        ) result = { kind: 'error', text: 'command returned an invalid source sequence' }
        if (options.signal?.aborted) result = { kind: 'error', text: 'command cancelled' }
      } catch (error) {
        result = {
          kind: 'error',
          text: options.signal?.aborted
            ? 'command cancelled'
            : error instanceof Error ? error.message : String(error),
        }
      }
      const settled = snapshot(result)
      session.append({
        type: 'command/done',
        turnId: commandId,
        commandId,
        name: parsed.name,
        result: settled,
      })
      return snapshot({ commandId, name: parsed.name, result: settled })
    } finally {
      this.#runningSessions.delete(session)
    }
  }
}
