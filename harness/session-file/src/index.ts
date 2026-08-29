import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import {
  type JsonValue,
  type ModelMessage,
  type SessionEvent,
  type SessionEventInput,
  snapshot,
} from '@deepseek-cordis/protocol'
import {
  projectSessionMessages,
  type Session,
  type SessionStore,
} from '@deepseek-cordis/session'

export const SESSION_FILE_SCHEMA_VERSION = 1

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
    super(`session file ${JSON.stringify(source)} uses unsupported schema version ${String(version)}`)
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
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || !isJsonValue(value.arguments)
  ) invalid(source, 'event contains an invalid tool call')
}

function validateStep(value: unknown, source: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    invalid(source, 'event contains an invalid step number')
  }
}

function validateEvent(value: unknown, index: number, source: string): SessionEvent {
  if (
    !isRecord(value)
    || value.sequence !== index + 1
    || typeof value.turnId !== 'string'
    || typeof value.type !== 'string'
  ) invalid(source, `event ${index + 1} has an invalid envelope or sequence`)

  switch (value.type) {
    case 'turn/start':
      break
    case 'user/message':
    case 'assistant/message':
      if (typeof value.content !== 'string') invalid(source, `${value.type} has invalid content`)
      break
    case 'step/start':
      validateStep(value.step, source)
      break
    case 'assistant/tool-calls':
      if (!Array.isArray(value.calls)) invalid(source, 'assistant/tool-calls has invalid calls')
      value.calls.forEach((call) => validateToolCall(call, source))
      break
    case 'tool/call':
      validateToolCall(value.call, source)
      break
    case 'tool/result':
      if (
        typeof value.callId !== 'string'
        || typeof value.name !== 'string'
        || typeof value.ok !== 'boolean'
      ) invalid(source, 'tool/result has an invalid envelope')
      if (value.ok) {
        if (!isJsonValue(value.output)) invalid(source, 'tool/result has invalid output')
      } else if (typeof value.error !== 'string') {
        invalid(source, 'tool/result has an invalid error')
      }
      break
    case 'step/end':
      validateStep(value.step, source)
      if (!['tool_calls', 'completed', 'failed'].includes(String(value.outcome))) {
        invalid(source, 'step/end has an invalid outcome')
      }
      break
    case 'turn/error':
      if (typeof value.error !== 'string') invalid(source, 'turn/error has an invalid error')
      break
    case 'turn/end':
      if (!['completed', 'failed'].includes(String(value.status))) {
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

  const migrated = value.schemaVersion === undefined
  if (!migrated && value.schemaVersion !== SESSION_FILE_SCHEMA_VERSION) {
    throw new UnsupportedSessionSchemaError(value.schemaVersion, source)
  }
  if (typeof value.id !== 'string' || !Array.isArray(value.events)) {
    invalid(source, 'document must contain a string id and events array')
  }
  return {
    id: value.id,
    events: value.events.map((event, index) => validateEvent(event, index, source)),
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
      try { closeSync(descriptor) } catch {}
    }
    if (!committed) {
      try { unlinkSync(temporaryPath) } catch {}
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
      try { closeSync(directoryDescriptor) } catch {}
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

  append(input: SessionEventInput): SessionEvent {
    const event = validateEvent(snapshot({
      ...input,
      sequence: this.#events.length + 1,
    }), this.#events.length, `session ${JSON.stringify(this.id)} append`)
    const candidate = [...this.#events, event]
    this.#persist(candidate)
    this.#events.push(event)
    return event
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
      if (decoded.migrated) persist(decoded.events)
      this.#sessions.set(
        decoded.id,
        new FileSession(decoded.id, decoded.events, persist),
      )
    }
  }
}
