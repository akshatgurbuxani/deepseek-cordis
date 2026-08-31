import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import {
  type ApprovalOutcome,
  type JsonValue,
  type ModelMessage,
  type SessionEvent,
  type SessionEventInput,
  snapshot,
  type ToolCall,
} from '@deepseek-cordis/protocol'
import {
  type AppendedSessionEvent,
  deriveSessionSurface,
  projectSessionMessages,
  type Session,
  type SessionStore,
} from '@deepseek-cordis/session'

export const SESSION_FILE_SCHEMA_VERSION = 6

export interface SessionFileDocument {
  readonly schemaVersion: typeof SESSION_FILE_SCHEMA_VERSION
  readonly id: string
  readonly events: readonly SessionEvent[]
}

export type SessionFileWriter = (filePath: string, contents: string) => void

export interface FileSessionStoreOptions {
  readonly directory: string
  readonly writer?: SessionFileWriter
}

export class SessionPersistenceError extends Error {}

export class UnsupportedSessionSchemaError extends SessionPersistenceError {
  readonly version: unknown

  constructor(version: unknown, source: string) {
    super(
      `session file ${JSON.stringify(source)} uses unsupported schema version ${String(version)}`,
    )
    this.version = version
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean' || typeof value === 'string') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function invalid(source: string, detail: string): never {
  throw new SessionPersistenceError(`invalid session file ${JSON.stringify(source)}: ${detail}`)
}

function validateToolCall(value: unknown, source: string): void {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !isJsonValue(value.arguments)
  )
    invalid(source, 'event contains an invalid tool call')
}

function validateToolSchema(value: unknown, source: string): void {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    !isJsonValue(value.inputSchema)
  )
    invalid(source, 'assistant usage contains an invalid tool schema')
}

function validateAssistantUsage(value: unknown, index: number, source: string): void {
  if (value === undefined) return
  if (
    !isRecord(value) ||
    typeof value.model !== 'string' ||
    value.model.trim().length === 0 ||
    typeof value.inputTokens !== 'number' ||
    !Number.isInteger(value.inputTokens) ||
    value.inputTokens < 0 ||
    typeof value.outputTokens !== 'number' ||
    !Number.isInteger(value.outputTokens) ||
    value.outputTokens < 0 ||
    !Array.isArray(value.inputSurfaceSequences) ||
    value.inputSurfaceSequences.some(
      (sequence) =>
        typeof sequence !== 'number' ||
        !Number.isInteger(sequence) ||
        sequence < 1 ||
        sequence >= index + 1,
    ) ||
    new Set(value.inputSurfaceSequences).size !== value.inputSurfaceSequences.length ||
    !Array.isArray(value.inputTools) ||
    (value.inputSystemPrompt !== undefined && typeof value.inputSystemPrompt !== 'string')
  )
    invalid(source, 'assistant event has invalid provider usage')
  value.inputTools.forEach((tool) => {
    validateToolSchema(tool, source)
  })
}

function validateStep(value: unknown, source: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    invalid(source, 'event contains an invalid step number')
  }
}

function validateEvent(value: unknown, index: number, source: string): SessionEvent {
  if (
    !isRecord(value) ||
    value.sequence !== index + 1 ||
    typeof value.turnId !== 'string' ||
    typeof value.type !== 'string'
  )
    invalid(source, `event ${index + 1} has an invalid envelope or sequence`)

  switch (value.type) {
    case 'turn/start':
      break
    case 'user/message':
      if (typeof value.content !== 'string') invalid(source, `${value.type} has invalid content`)
      break
    case 'assistant/message':
      if (typeof value.content !== 'string') invalid(source, `${value.type} has invalid content`)
      validateAssistantUsage(value.usage, index, source)
      break
    case 'step/start':
      validateStep(value.step, source)
      break
    case 'assistant/tool-calls':
      if (!Array.isArray(value.calls)) invalid(source, 'assistant/tool-calls has invalid calls')
      value.calls.forEach((call) => {
        validateToolCall(call, source)
      })
      validateAssistantUsage(value.usage, index, source)
      break
    case 'compaction/summary':
      if (
        typeof value.summary !== 'string' ||
        value.summary.trim().length === 0 ||
        typeof value.summarizer !== 'string' ||
        value.summarizer.trim().length === 0 ||
        !Array.isArray(value.shadowedSequences) ||
        value.shadowedSequences.length === 0 ||
        value.shadowedSequences.some(
          (sequence) =>
            typeof sequence !== 'number' ||
            !Number.isInteger(sequence) ||
            sequence < 1 ||
            sequence >= index + 1,
        ) ||
        new Set(value.shadowedSequences).size !== value.shadowedSequences.length
      )
        invalid(source, 'compaction/summary has invalid provenance')
      break
    case 'context-budget/decision':
      if (
        !['pressure', 'context_overflow'].includes(String(value.trigger)) ||
        typeof value.model !== 'string' ||
        value.model.trim().length === 0 ||
        typeof value.measuredTokens !== 'number' ||
        !Number.isInteger(value.measuredTokens) ||
        value.measuredTokens < 0 ||
        (value.contextWindow !== undefined &&
          (typeof value.contextWindow !== 'number' ||
            !Number.isInteger(value.contextWindow) ||
            value.contextWindow < 1)) ||
        (value.thresholdTokens !== undefined &&
          (typeof value.thresholdTokens !== 'number' ||
            !Number.isInteger(value.thresholdTokens) ||
            value.thresholdTokens < 1)) ||
        (value.trigger === 'pressure' &&
          (value.contextWindow === undefined ||
            value.thresholdTokens === undefined ||
            value.thresholdTokens > value.contextWindow)) ||
        (value.trigger === 'context_overflow' && value.thresholdTokens !== undefined) ||
        !['compacted', 'no_progress', 'failed'].includes(String(value.outcome)) ||
        (value.summarySequence !== undefined &&
          (typeof value.summarySequence !== 'number' ||
            !Number.isInteger(value.summarySequence) ||
            value.summarySequence < 1 ||
            value.summarySequence >= index + 1)) ||
        (value.error !== undefined &&
          (typeof value.error !== 'string' || value.error.trim().length === 0)) ||
        (value.outcome === 'compacted') !== (value.summarySequence !== undefined) ||
        (value.outcome === 'failed') !== (value.error !== undefined)
      )
        invalid(source, 'context-budget/decision has invalid fields')
      break
    case 'tool/call':
      validateToolCall(value.call, source)
      break
    case 'approval/asked':
      if (
        typeof value.callId !== 'string' ||
        typeof value.name !== 'string' ||
        !['filesystem', 'shell', 'browser', 'external'].includes(String(value.risk)) ||
        typeof value.reason !== 'string' ||
        value.reason.trim().length === 0
      )
        invalid(source, 'approval/asked has invalid fields')
      break
    case 'approval/decided':
      if (
        typeof value.callId !== 'string' ||
        typeof value.name !== 'string' ||
        !['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(String(value.outcome))
      )
        invalid(source, 'approval/decided has invalid fields')
      break
    case 'sandbox/prepared':
      if (
        typeof value.callId !== 'string' ||
        typeof value.name !== 'string' ||
        typeof value.profile !== 'string' ||
        value.profile.trim().length === 0 ||
        typeof value.provider !== 'string' ||
        value.provider.trim().length === 0 ||
        !['full', 'partial'].includes(String(value.enforcement))
      )
        invalid(source, 'sandbox/prepared has invalid fields')
      break
    case 'command/run':
      if (
        typeof value.commandId !== 'string' ||
        value.commandId.length === 0 ||
        value.turnId !== value.commandId ||
        typeof value.name !== 'string' ||
        !/^[a-z][a-z0-9_-]*$/.test(value.name) ||
        typeof value.rawInput !== 'string'
      )
        invalid(source, 'command/run has invalid fields')
      break
    case 'command/done':
      if (
        typeof value.commandId !== 'string' ||
        value.commandId.length === 0 ||
        value.turnId !== value.commandId ||
        typeof value.name !== 'string' ||
        !/^[a-z][a-z0-9_-]*$/.test(value.name) ||
        !isRecord(value.result) ||
        !['success', 'error'].includes(String(value.result.kind)) ||
        (value.result.text !== undefined && typeof value.result.text !== 'string') ||
        (value.result.kind === 'error' && typeof value.result.text !== 'string') ||
        (value.result.sourceSequence !== undefined &&
          (value.result.kind !== 'success' ||
            typeof value.result.sourceSequence !== 'number' ||
            !Number.isInteger(value.result.sourceSequence) ||
            value.result.sourceSequence < 1 ||
            value.result.sourceSequence >= index + 1))
      )
        invalid(source, 'command/done has invalid fields')
      break
    case 'tool/result':
      if (
        typeof value.callId !== 'string' ||
        typeof value.name !== 'string' ||
        typeof value.ok !== 'boolean'
      )
        invalid(source, 'tool/result has an invalid envelope')
      if (value.ok) {
        if (!isJsonValue(value.output)) invalid(source, 'tool/result has invalid output')
      } else if (typeof value.error !== 'string') {
        invalid(source, 'tool/result has an invalid error')
      }
      break
    case 'step/end':
      validateStep(value.step, source)
      if (
        !['tool_calls', 'completed', 'failed', 'aborted', 'interrupted'].includes(
          String(value.outcome),
        )
      ) {
        invalid(source, 'step/end has an invalid outcome')
      }
      break
    case 'turn/error':
      if (typeof value.error !== 'string') invalid(source, 'turn/error has an invalid error')
      break
    case 'turn/end':
      if (!['completed', 'failed', 'aborted', 'interrupted'].includes(String(value.status))) {
        invalid(source, 'turn/end has an invalid status')
      }
      break
    default:
      invalid(source, `event ${index + 1} has unknown type ${JSON.stringify(value.type)}`)
  }
  return snapshot(value) as unknown as SessionEvent
}

interface DecodedDocument {
  readonly id: string
  readonly events: readonly SessionEvent[]
  readonly migrated: boolean
}

function decodeDocument(contents: string, source: string): DecodedDocument {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch (error) {
    throw new SessionPersistenceError(`session file ${JSON.stringify(source)} is not valid JSON`, {
      cause: error,
    })
  }
  if (!isRecord(value)) invalid(source, 'document is not an object')

  const migrated =
    value.schemaVersion === undefined ||
    value.schemaVersion === 1 ||
    value.schemaVersion === 2 ||
    value.schemaVersion === 3 ||
    value.schemaVersion === 4 ||
    value.schemaVersion === 5
  if (!migrated && value.schemaVersion !== SESSION_FILE_SCHEMA_VERSION) {
    throw new UnsupportedSessionSchemaError(value.schemaVersion, source)
  }
  if (typeof value.id !== 'string' || !Array.isArray(value.events)) {
    invalid(source, 'document must contain a string id and events array')
  }
  const events = value.events.map((event, index) => validateEvent(event, index, source))
  for (const event of events) {
    if (
      event.type !== 'command/done' ||
      event.result.kind !== 'success' ||
      event.result.sourceSequence === undefined
    )
      continue
    const sourceEvent = events[event.result.sourceSequence - 1]
    if (
      sourceEvent === undefined ||
      sourceEvent.type === 'command/run' ||
      sourceEvent.type === 'command/done'
    )
      invalid(source, 'command/done references an invalid source event')
  }
  if (
    (value.schemaVersion === undefined || value.schemaVersion === 1) &&
    events.some((event) => event.type === 'compaction/summary')
  )
    invalid(source, 'legacy schema contains an event introduced by a newer schema')
  if (
    (value.schemaVersion === undefined || value.schemaVersion === 1 || value.schemaVersion === 2) &&
    events.some((event) => event.type === 'context-budget/decision')
  )
    invalid(source, 'legacy schema contains an event introduced by a newer schema')
  if (
    (value.schemaVersion === undefined ||
      value.schemaVersion === 1 ||
      value.schemaVersion === 2 ||
      value.schemaVersion === 3 ||
      value.schemaVersion === 4) &&
    events.some(
      (event) =>
        (event.type === 'assistant/message' || event.type === 'assistant/tool-calls') &&
        event.usage !== undefined,
    )
  )
    invalid(source, 'legacy schema contains an event introduced by a newer schema')
  if (
    value.schemaVersion !== SESSION_FILE_SCHEMA_VERSION &&
    events.some((event) => event.type === 'command/run' || event.type === 'command/done')
  )
    invalid(source, 'legacy schema contains an event introduced by a newer schema')
  if (
    (value.schemaVersion === undefined ||
      value.schemaVersion === 1 ||
      value.schemaVersion === 2 ||
      value.schemaVersion === 3 ||
      value.schemaVersion === 4) &&
    events.some(
      (event) =>
        event.type === 'approval/asked' ||
        event.type === 'approval/decided' ||
        event.type === 'sandbox/prepared',
    )
  )
    invalid(source, 'legacy schema contains an event introduced by a newer schema')
  try {
    deriveSessionSurface(events)
  } catch (error) {
    invalid(source, error instanceof Error ? error.message : String(error))
  }
  return {
    id: value.id,
    events,
    migrated,
  }
}

function encodeDocument(id: string, events: readonly SessionEvent[]): string {
  const document: SessionFileDocument = {
    schemaVersion: SESSION_FILE_SCHEMA_VERSION,
    id,
    events,
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

export const TOOL_NOT_STARTED = 'tool call was interrupted before execution started'
export const TOOL_OUTCOME_UNKNOWN = 'tool outcome is unknown because execution was interrupted'
export const COMMAND_INTERRUPTED = 'command was interrupted before a result was recorded'

interface PendingToolCall {
  readonly call: ToolCall
  started: boolean
  approval?: 'asked' | ApprovalOutcome
  sandboxPrepared?: boolean
}

export function interruptedTurnClosers(
  events: readonly SessionEvent[],
  source = 'session event stream',
): readonly SessionEvent[] {
  const closers: SessionEvent[] = []
  const append = (input: SessionEventInput) => {
    closers.push(
      snapshot({
        ...input,
        sequence: events.length + closers.length + 1,
      }) as SessionEvent,
    )
  }
  const openCommands = new Map<string, Extract<SessionEvent, { readonly type: 'command/run' }>>()
  let commandScanTurn: string | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (openCommands.size > 0) invalid(source, 'turn/start overlaps an open command')
      commandScanTurn = event.turnId
    }
    if (event.type === 'turn/end' && event.turnId === commandScanTurn) {
      commandScanTurn = undefined
    }
    if (event.type === 'command/run') {
      if (commandScanTurn !== undefined) invalid(source, 'command/run appears inside a turn')
      if (openCommands.size > 0) invalid(source, 'command/run overlaps another command')
      openCommands.set(event.commandId, event)
    }
    if (event.type === 'command/done') {
      if (commandScanTurn !== undefined) invalid(source, 'command/done appears inside a turn')
      const run = openCommands.get(event.commandId)
      if (!run || run.name !== event.name) {
        invalid(source, `command/done ${JSON.stringify(event.commandId)} has no matching run`)
      }
      openCommands.delete(event.commandId)
    }
  }
  for (const run of openCommands.values()) {
    append({
      type: 'command/done',
      turnId: run.commandId,
      commandId: run.commandId,
      name: run.name,
      result: { kind: 'error', text: COMMAND_INTERRUPTED },
    })
  }

  const lastTurnEnd = events.findLastIndex((event) => event.type === 'turn/end')
  const suffix = events.slice(lastTurnEnd + 1)
  if (suffix.length === 0) return closers
  const nextTurn = suffix.findIndex((event) => event.type === 'turn/start')
  const isMaintenance = (event: SessionEvent) =>
    event.type === 'compaction/summary' ||
    event.type === 'context-budget/decision' ||
    event.type === 'command/run' ||
    event.type === 'command/done'
  if (nextTurn === -1 && suffix.every(isMaintenance)) return closers
  if (nextTurn === -1 || suffix.slice(0, nextTurn).some((event) => !isMaintenance(event))) {
    invalid(source, 'events follow the last closed turn without a new turn/start')
  }
  const tail = suffix.slice(nextTurn)

  const turnId = tail[0]!.turnId
  let openStep: number | undefined
  const pending = new Map<string, PendingToolCall>()

  for (const event of tail.slice(1)) {
    if (
      event.type !== 'compaction/summary' &&
      event.type !== 'context-budget/decision' &&
      event.turnId !== turnId
    ) {
      invalid(source, 'open trailing turn contains a mismatched turn id')
    }
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
        return invalid(source, 'open trailing turn contains a nested turn boundary')
      case 'step/start':
        if (openStep !== undefined) {
          invalid(source, 'open trailing turn contains nested step/start events')
        }
        openStep = event.step
        break
      case 'assistant/tool-calls':
        if (openStep === undefined) {
          invalid(source, 'assistant tool calls appear outside an open step')
        }
        if (pending.size > 0) {
          invalid(source, 'open step contains overlapping assistant tool-call batches')
        }
        for (const call of event.calls) {
          if (pending.has(call.id)) {
            invalid(source, `open step duplicates tool call id ${JSON.stringify(call.id)}`)
          }
          pending.set(call.id, { call, started: false })
        }
        break
      case 'tool/call': {
        if (openStep === undefined) invalid(source, 'tool/call appears outside an open step')
        const entry = pending.get(event.call.id)
        if (!entry || entry.call.name !== event.call.name || entry.started) {
          invalid(source, `tool/call ${JSON.stringify(event.call.id)} has no pending call`)
        }
        entry.started = true
        break
      }
      case 'approval/asked': {
        const entry = pending.get(event.callId)
        if (openStep === undefined || !entry || !entry.started || entry.approval !== undefined) {
          invalid(source, `${event.type} ${JSON.stringify(event.callId)} has no pending call`)
        }
        entry.approval = 'asked'
        entry.started = false
        break
      }
      case 'approval/decided': {
        const entry = pending.get(event.callId)
        if (openStep === undefined || !entry || entry.approval !== 'asked') {
          invalid(source, `${event.type} ${JSON.stringify(event.callId)} has no matching ask`)
        }
        entry.approval = event.outcome
        break
      }
      case 'sandbox/prepared': {
        const entry = pending.get(event.callId)
        if (
          openStep === undefined ||
          !entry ||
          entry.approval !== 'allowed-once' ||
          entry.sandboxPrepared
        ) {
          invalid(source, `${event.type} ${JSON.stringify(event.callId)} is not approved`)
        }
        entry.sandboxPrepared = true
        entry.started = true
        break
      }
      case 'tool/result': {
        if (openStep === undefined) invalid(source, 'tool/result appears outside an open step')
        const entry = pending.get(event.callId)
        if (!entry || entry.call.name !== event.name) {
          invalid(source, `tool/result ${JSON.stringify(event.callId)} has no pending call`)
        }
        pending.delete(event.callId)
        break
      }
      case 'step/end':
        if (openStep !== event.step) {
          invalid(source, 'step/end does not match the open step')
        }
        if (pending.size > 0) {
          invalid(source, 'closed trailing step still has unanswered tool calls')
        }
        openStep = undefined
        break
      case 'assistant/message':
        if (openStep === undefined) {
          invalid(source, 'assistant message appears outside an open step')
        }
        break
      case 'compaction/summary':
        if (openStep !== undefined) {
          invalid(source, 'compaction appears inside an open trailing step')
        }
        break
      case 'context-budget/decision':
        if (openStep !== undefined) {
          invalid(source, 'context budget decision appears inside an open trailing step')
        }
        break
      case 'command/run':
      case 'command/done':
        return invalid(source, `${event.type} appears inside an open trailing turn`)
      case 'user/message':
      case 'turn/error':
        break
    }
  }

  for (const { call, started } of pending.values()) {
    append({
      type: 'tool/result',
      turnId,
      callId: call.id,
      name: call.name,
      ok: false,
      error: started ? TOOL_OUTCOME_UNKNOWN : TOOL_NOT_STARTED,
    })
  }
  if (openStep !== undefined) {
    append({ type: 'step/end', turnId, step: openStep, outcome: 'interrupted' })
  }
  append({ type: 'turn/end', turnId, status: 'interrupted' })
  return closers
}

export function sessionFilePath(directory: string, id: string): string {
  const digest = createHash('sha256').update(id).digest('hex')
  return join(resolve(directory), `session-${digest}.json`)
}

export function atomicReplaceFile(filePath: string, contents: string): void {
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let descriptor: number | undefined
  let committed = false
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, contents, { encoding: 'utf8' })
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporaryPath, filePath)
    committed = true
  } catch (error) {
    throw new SessionPersistenceError(`failed to atomically replace ${JSON.stringify(filePath)}`, {
      cause: error,
    })
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {}
    }
    if (!committed) {
      try {
        unlinkSync(temporaryPath)
      } catch {}
    }
  }

  // The rename is already the commit point. Best-effort directory fsync makes
  // that rename durable without reporting a false failure after it committed.
  let directoryDescriptor: number | undefined
  try {
    directoryDescriptor = openSync(dirname(filePath), 'r')
    fsyncSync(directoryDescriptor)
  } catch {
    // Some platforms do not support fsync on directories.
  } finally {
    if (directoryDescriptor !== undefined) {
      try {
        closeSync(directoryDescriptor)
      } catch {}
    }
  }
}

export class FileSession implements Session {
  readonly id: string
  readonly #events: SessionEvent[]
  readonly #persist: (events: readonly SessionEvent[]) => void

  constructor(
    id: string,
    events: readonly SessionEvent[],
    persist: (events: readonly SessionEvent[]) => void,
  ) {
    this.id = id
    this.#events = [...events]
    this.#persist = persist
  }

  get events(): readonly SessionEvent[] {
    return [...this.#events]
  }

  append<const Input extends SessionEventInput>(input: Input): AppendedSessionEvent<Input> {
    const event = validateEvent(
      snapshot({
        ...input,
        sequence: this.#events.length + 1,
      }),
      this.#events.length,
      `session ${JSON.stringify(this.id)} append`,
    )
    const candidate = [...this.#events, event]
    if (
      event.type === 'compaction/summary' ||
      event.type === 'context-budget/decision' ||
      ((event.type === 'assistant/message' || event.type === 'assistant/tool-calls') &&
        event.usage !== undefined)
    ) {
      deriveSessionSurface(candidate)
    }
    this.#persist(candidate)
    this.#events.push(event)
    return event as AppendedSessionEvent<Input>
  }

  projectMessages(): readonly ModelMessage[] {
    return projectSessionMessages(this.#events)
  }
}

export class FileSessionStore implements SessionStore {
  readonly directory: string
  readonly #sessions = new Map<string, FileSession>()
  readonly #writer: SessionFileWriter

  constructor(options: FileSessionStoreOptions) {
    this.directory = resolve(options.directory)
    this.#writer = options.writer ?? atomicReplaceFile
    mkdirSync(this.directory, { recursive: true })
    this.#load()
  }

  create(id: string): FileSession {
    if (this.#sessions.has(id)) {
      throw new Error(`session ${JSON.stringify(id)} already exists`)
    }
    const filePath = sessionFilePath(this.directory, id)
    if (existsSync(filePath)) {
      throw new SessionPersistenceError(
        `session file ${JSON.stringify(filePath)} appeared after the store was opened`,
      )
    }
    const persist = (events: readonly SessionEvent[]) => {
      this.#writer(filePath, encodeDocument(id, events))
    }
    persist([])
    const session = new FileSession(id, [], persist)
    this.#sessions.set(id, session)
    return session
  }

  get(id: string): FileSession | undefined {
    return this.#sessions.get(id)
  }

  #load(): void {
    const files = readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^session-[a-f0-9]{64}\.json$/.test(entry.name))
      .map((entry) => join(this.directory, entry.name))
      .sort()

    for (const filePath of files) {
      const decoded = decodeDocument(readFileSync(filePath, 'utf8'), filePath)
      if (filePath !== sessionFilePath(this.directory, decoded.id)) {
        invalid(filePath, 'filename does not match the stored session id')
      }
      if (this.#sessions.has(decoded.id)) {
        invalid(filePath, `duplicates session id ${JSON.stringify(decoded.id)}`)
      }
      const persist = (events: readonly SessionEvent[]) => {
        this.#writer(filePath, encodeDocument(decoded.id, events))
      }
      const closers = interruptedTurnClosers(decoded.events, filePath)
      const events = [...decoded.events, ...closers]
      if (decoded.migrated || closers.length > 0) persist(events)
      this.#sessions.set(decoded.id, new FileSession(decoded.id, events, persist))
    }
  }
}
