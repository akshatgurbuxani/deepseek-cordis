import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  atomicReplaceFile,
  FileSessionStore,
  SESSION_FILE_SCHEMA_VERSION,
  SessionPersistenceError,
  sessionFilePath,
  UnsupportedSessionSchemaError,
} from '@deepseek-cordis/session-file'

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-session-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  return directory
}

test('sessions survive restart with immutable events and projected model history', (t) => {
  const directory = temporaryDirectory(t)
  const firstStore = new FileSessionStore({ directory })
  const session = firstStore.create('../durable/session')
  session.append({ type: 'turn/start', turnId: 'turn-1' })
  session.append({ type: 'user/message', turnId: 'turn-1', content: 'add 2 and 3' })
  session.append({
    type: 'assistant/tool-calls',
    turnId: 'turn-1',
    calls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }],
  })
  session.append({
    type: 'tool/result', turnId: 'turn-1', callId: 'call-1', name: 'add', ok: true, output: 5,
  })
  session.append({ type: 'assistant/message', turnId: 'turn-1', content: '5' })
  session.append({ type: 'turn/end', turnId: 'turn-1', status: 'completed' })
  session.append({ type: 'turn/start', turnId: 'turn-2' })
  session.append({ type: 'step/start', turnId: 'turn-2', step: 1 })
  session.append({ type: 'step/end', turnId: 'turn-2', step: 1, outcome: 'aborted' })
  session.append({ type: 'turn/end', turnId: 'turn-2', status: 'aborted' })

  const filePath = sessionFilePath(directory, session.id)
  assert.equal(filePath.startsWith(`${resolve(directory)}/`), true)
  assert.equal(statSync(filePath).mode & 0o777, 0o600)

  const resumed = new FileSessionStore({ directory }).get(session.id)
  assert.ok(resumed)
  assert.deepEqual(resumed.events, session.events)
  assert.equal(Object.isFrozen(resumed.events[0]), true)
  assert.deepEqual(resumed.projectMessages(), [
    { role: 'user', content: 'add 2 and 3' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }],
    },
    { role: 'tool', callId: 'call-1', name: 'add', ok: true, output: 5 },
    { role: 'assistant', content: '5' },
  ])
  assert.throws(() => firstStore.create(session.id), /already exists/)
})

test('a failed atomic append leaves memory and the committed file unchanged', (t) => {
  const directory = temporaryDirectory(t)
  let fail = false
  const store = new FileSessionStore({
    directory,
    writer: (filePath, contents) => {
      if (fail) throw new SessionPersistenceError('simulated storage failure')
      atomicReplaceFile(filePath, contents)
    },
  })
  const session = store.create('failure-safe')
  session.append({ type: 'turn/start', turnId: 'turn-1' })
  const committed = readFileSync(sessionFilePath(directory, session.id), 'utf8')

  fail = true
  assert.throws(
    () => session.append({ type: 'turn/end', turnId: 'turn-1', status: 'completed' }),
    /simulated storage failure/,
  )
  assert.equal(session.events.length, 1)
  assert.equal(readFileSync(sessionFilePath(directory, session.id), 'utf8'), committed)
  assert.equal(readdirSync(directory).some((name) => name.endsWith('.tmp')), false)
  assert.equal(new FileSessionStore({ directory }).get(session.id)?.events.length, 1)

  const destinationDirectory = join(directory, 'cannot-replace-directory')
  mkdirSync(destinationDirectory)
  assert.throws(
    () => atomicReplaceFile(destinationDirectory, 'candidate'),
    /failed to atomically replace/,
  )
  assert.equal(readdirSync(directory).some((name) => name.endsWith('.tmp')), false)
})

test('versionless V0 documents migrate once to the current schema', (t) => {
  const directory = temporaryDirectory(t)
  const id = 'legacy'
  const filePath = sessionFilePath(directory, id)
  writeFileSync(filePath, JSON.stringify({
    id,
    events: [{ type: 'turn/start', turnId: 'legacy:turn:1', sequence: 1 }],
  }))

  const session = new FileSessionStore({ directory }).get(id)
  assert.equal(session?.events.length, 1)
  const migrated = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
  assert.equal(migrated.schemaVersion, SESSION_FILE_SCHEMA_VERSION)
})

test('future schemas and corrupt documents fail explicitly without rewriting input', (t) => {
  const directory = temporaryDirectory(t)
  const id = 'future'
  const filePath = sessionFilePath(directory, id)
  const future = JSON.stringify({ schemaVersion: 99, id, events: [] })
  writeFileSync(filePath, future)

  assert.throws(
    () => new FileSessionStore({ directory }),
    (error) => error instanceof UnsupportedSessionSchemaError && error.version === 99,
  )
  assert.equal(readFileSync(filePath, 'utf8'), future)

  writeFileSync(filePath, '{not json')
  assert.throws(() => new FileSessionStore({ directory }), /not valid JSON/)

  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    id,
    events: [{ type: 'turn/start', turnId: 'turn-1', sequence: 2 }],
  }))
  assert.throws(() => new FileSessionStore({ directory }), /invalid envelope or sequence/)

  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    id,
    events: [{ type: 'not-an-event', turnId: 'turn-1', sequence: 1 }],
  }))
  assert.throws(() => new FileSessionStore({ directory }), /unknown type/)
})

test('every persisted event variant is validated before it can become live state', (t) => {
  const directory = temporaryDirectory(t)
  const id = 'validation'
  const filePath = sessionFilePath(directory, id)
  const invalidDocuments: ReadonlyArray<readonly [unknown, RegExp]> = [
    [null, /document is not an object/],
    [{ schemaVersion: 1, id }, /string id and events array/],
    [{ type: 'user/message', turnId: 'turn-1', sequence: 1 }, /invalid content/],
    [{ type: 'step/start', turnId: 'turn-1', sequence: 1, step: 0 }, /invalid step number/],
    [{ type: 'assistant/tool-calls', turnId: 'turn-1', sequence: 1 }, /invalid calls/],
    [{
      type: 'assistant/tool-calls', turnId: 'turn-1', sequence: 1,
      calls: [{ id: 'call-1', name: 'add' }],
    }, /invalid tool call/],
    [{ type: 'tool/call', turnId: 'turn-1', sequence: 1, call: null }, /invalid tool call/],
    [{ type: 'tool/result', turnId: 'turn-1', sequence: 1, ok: true }, /invalid envelope/],
    [{
      type: 'tool/result', turnId: 'turn-1', sequence: 1,
      callId: 'call-1', name: 'add', ok: true,
    }, /invalid output/],
    [{
      type: 'tool/result', turnId: 'turn-1', sequence: 1,
      callId: 'call-1', name: 'add', ok: false,
    }, /invalid error/],
    [{ type: 'step/end', turnId: 'turn-1', sequence: 1, step: 1, outcome: 'later' }, /invalid outcome/],
    [{ type: 'turn/error', turnId: 'turn-1', sequence: 1 }, /invalid error/],
    [{ type: 'turn/end', turnId: 'turn-1', sequence: 1, status: 'later' }, /invalid status/],
  ]

  for (const [eventOrDocument, expected] of invalidDocuments) {
    const isDocument = eventOrDocument === null || (
      typeof eventOrDocument === 'object'
      && eventOrDocument !== null
      && 'schemaVersion' in eventOrDocument
    )
    const document = isDocument
      ? eventOrDocument
      : { schemaVersion: 1, id, events: [eventOrDocument] }
    writeFileSync(filePath, JSON.stringify(document))
    assert.throws(() => new FileSessionStore({ directory }), expected)
  }

  writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, id, events: [] }))
  const session = new FileSessionStore({ directory }).get(id)
  assert.ok(session)
  const before = readFileSync(filePath, 'utf8')
  assert.throws(() => session.append({
    type: 'tool/result',
    turnId: 'turn-1',
    callId: 'call-1',
    name: 'add',
    ok: true,
    output: Number.NaN,
  }), /invalid output/)
  assert.equal(session.events.length, 0)
  assert.equal(readFileSync(filePath, 'utf8'), before)
})

test('canonical files must match their stored IDs while unrelated and temporary files are ignored', (t) => {
  const directory = temporaryDirectory(t)
  writeFileSync(join(directory, 'notes.json'), '{}')
  writeFileSync(join(directory, '.session-orphan.tmp'), 'partial')
  const openedStore = new FileSessionStore({ directory })

  const appearedId = 'appeared-late'
  atomicReplaceFile(sessionFilePath(directory, appearedId), JSON.stringify({
    schemaVersion: 1, id: appearedId, events: [],
  }))
  assert.throws(() => openedStore.create(appearedId), /appeared after the store was opened/)

  const filePath = sessionFilePath(directory, 'expected')
  writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, id: 'different', events: [] }))
  assert.throws(() => new FileSessionStore({ directory }), /filename does not match/)
})
