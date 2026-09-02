import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  atomicReplaceFile,
  COMMAND_INTERRUPTED,
  FileSessionStore,
  SESSION_FILE_SCHEMA_VERSION,
  SessionPersistenceError,
  SessionWriteConflictError,
  sessionFilePath,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  UnsupportedSessionSchemaError,
} from '@deepseek-cordis/session-file'

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-session-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
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
    usage: {
      model: 'provider/model',
      inputTokens: 12,
      outputTokens: 3,
      inputSurfaceSequences: [2],
      inputTools: [],
    },
  })
  session.append({
    type: 'tool/call',
    turnId: 'turn-1',
    call: { id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } },
  })
  session.append({
    type: 'approval/asked',
    turnId: 'turn-1',
    callId: 'call-1',
    name: 'add',
    risk: 'external',
    reason: 'invoke a consequential provider',
  })
  session.append({
    type: 'approval/decided',
    turnId: 'turn-1',
    callId: 'call-1',
    name: 'add',
    outcome: 'allowed-once',
  })
  session.append({
    type: 'sandbox/prepared',
    turnId: 'turn-1',
    callId: 'call-1',
    name: 'add',
    profile: 'isolated',
    provider: 'test/provider',
    enforcement: 'full',
  })
  session.append({
    type: 'tool/result',
    turnId: 'turn-1',
    callId: 'call-1',
    name: 'add',
    ok: true,
    output: 5,
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
  assert.equal(
    readdirSync(directory).some((name) => name.endsWith('.tmp')),
    false,
  )
  const repaired = new FileSessionStore({ directory }).get(session.id)
  assert.equal(repaired?.events.length, 2)
  assert.deepEqual(repaired?.events.at(-1), {
    type: 'turn/end',
    turnId: 'turn-1',
    status: 'interrupted',
    sequence: 2,
  })

  const destinationDirectory = join(directory, 'cannot-replace-directory')
  mkdirSync(destinationDirectory)
  assert.throws(
    () => atomicReplaceFile(destinationDirectory, 'candidate'),
    /failed to atomically replace/,
  )
  assert.equal(
    readdirSync(directory).some((name) => name.endsWith('.tmp')),
    false,
  )
})

test('independent stores reject stale revisions instead of erasing committed events', (t) => {
  const directory = temporaryDirectory(t)
  new FileSessionStore({ directory }).create('shared-revision')
  const first = new FileSessionStore({ directory }).get('shared-revision')
  const stale = new FileSessionStore({ directory }).get('shared-revision')
  assert.ok(first)
  assert.ok(stale)

  first.append({ type: 'turn/start', turnId: 'shared-revision:turn:1' })
  assert.throws(
    () => stale.append({ type: 'turn/start', turnId: 'shared-revision:turn:2' }),
    (error: unknown) => {
      assert.ok(error instanceof SessionWriteConflictError)
      assert.equal(error.code, 'SESSION_STALE_WRITER')
      assert.match(error.message, /reopen it before writing/)
      return true
    },
  )
  assert.deepEqual(stale.events, [])
  const stored = JSON.parse(
    readFileSync(sessionFilePath(directory, 'shared-revision'), 'utf8'),
  ) as { events: Array<{ turnId: string }> }
  assert.deepEqual(
    stored.events.map(({ turnId }) => turnId),
    ['shared-revision:turn:1'],
  )
})

test('stores opened before creation coordinate the same session identity', (t) => {
  const directory = temporaryDirectory(t)
  const winner = new FileSessionStore({ directory })
  const contender = new FileSessionStore({ directory })
  winner.create('create-race')

  assert.throws(
    () => contender.create('create-race'),
    (error: unknown) => {
      assert.ok(error instanceof SessionWriteConflictError)
      assert.equal(error.code, 'SESSION_STALE_WRITER')
      return true
    },
  )
  assert.equal(contender.get('create-race'), undefined)
})

test('a live cross-process writer owns the session lock and leaves stale peers unchanged', async (t) => {
  const directory = temporaryDirectory(t)
  new FileSessionStore({ directory }).create('cross-process')
  const peer = new FileSessionStore({ directory }).get('cross-process')
  assert.ok(peer)
  const marker = join(directory, 'writer-entered')
  const release = join(directory, 'release-writer')
  const script = `
    import { existsSync, writeFileSync } from 'node:fs'
    import { atomicReplaceFile, FileSessionStore } from '@deepseek-cordis/session-file'
    const store = new FileSessionStore({
      directory: process.env.TEST_SESSION_DIRECTORY,
      writer(filePath, contents) {
        writeFileSync(process.env.TEST_SESSION_MARKER, 'locked')
        const deadline = Date.now() + 10_000
        while (!existsSync(process.env.TEST_SESSION_RELEASE)) {
          if (Date.now() >= deadline) throw new Error('timed out waiting for lock release')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        }
        atomicReplaceFile(filePath, contents)
      },
    })
    store.get('cross-process').append({ type: 'turn/start', turnId: 'cross-process:turn:child' })
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      TEST_SESSION_DIRECTORY: directory,
      TEST_SESSION_MARKER: marker,
      TEST_SESSION_RELEASE: release,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  await waitForFile(marker)

  try {
    assert.throws(
      () => peer.append({ type: 'turn/start', turnId: 'cross-process:turn:peer' }),
      (error: unknown) => {
        assert.ok(error instanceof SessionWriteConflictError)
        assert.equal(error.code, 'SESSION_WRITE_BUSY')
        return true
      },
    )
  } finally {
    writeFileSync(release, 'continue')
  }
  assert.deepEqual(peer.events, [])
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', resolveExit)
  })
  assert.equal(exitCode, 0, Buffer.concat(stderr).toString('utf8'))

  assert.throws(
    () => peer.append({ type: 'turn/start', turnId: 'cross-process:turn:peer' }),
    (error: unknown) => {
      assert.ok(error instanceof SessionWriteConflictError)
      assert.equal(error.code, 'SESSION_STALE_WRITER')
      return true
    },
  )
  const reopened = new FileSessionStore({ directory }).get('cross-process')
  assert.equal(reopened?.events[0]?.turnId, 'cross-process:turn:child')
})

test('a dead local writer lock is reclaimed without discarding the committed revision', (t) => {
  const directory = temporaryDirectory(t)
  new FileSessionStore({ directory }).create('crashed-writer')
  const survivor = new FileSessionStore({ directory }).get('crashed-writer')
  assert.ok(survivor)
  const script = `
    import { FileSessionStore } from '@deepseek-cordis/session-file'
    const store = new FileSessionStore({
      directory: process.env.TEST_SESSION_DIRECTORY,
      writer() { process.exit(23) },
    })
    store.get('crashed-writer').append({ type: 'turn/start', turnId: 'never-committed' })
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: resolve('.'),
    env: { ...process.env, TEST_SESSION_DIRECTORY: directory },
    encoding: 'utf8',
  })
  assert.equal(child.status, 23, child.stderr)

  survivor.append({ type: 'turn/start', turnId: 'crashed-writer:turn:1' })
  assert.equal(survivor.events.length, 1)
  assert.equal(
    readdirSync(directory).some((name) => name.includes('.lock')),
    false,
  )
})

test('V0 through V5 documents migrate once to the current schema', (t) => {
  const directory = temporaryDirectory(t)
  const id = 'legacy'
  const filePath = sessionFilePath(directory, id)
  writeFileSync(
    filePath,
    JSON.stringify({
      id,
      events: [{ type: 'turn/start', turnId: 'legacy:turn:1', sequence: 1 }],
    }),
  )

  const session = new FileSessionStore({ directory }).get(id)
  assert.equal(session?.events.length, 2)
  assert.equal(session?.events.at(-1)?.type, 'turn/end')
  const migrated = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
  assert.equal(migrated.schemaVersion, SESSION_FILE_SCHEMA_VERSION)
  assert.equal((migrated.events as unknown[]).length, 2)

  const v1Id = 'schema-v1'
  const v1Path = sessionFilePath(directory, v1Id)
  writeFileSync(v1Path, JSON.stringify({ schemaVersion: 1, id: v1Id, events: [] }))
  assert.ok(new FileSessionStore({ directory }).get(v1Id))
  const migratedV1 = JSON.parse(readFileSync(v1Path, 'utf8')) as Record<string, unknown>
  assert.equal(migratedV1.schemaVersion, SESSION_FILE_SCHEMA_VERSION)

  const v2Id = 'schema-v2'
  const v2Path = sessionFilePath(directory, v2Id)
  writeFileSync(
    v2Path,
    JSON.stringify({
      schemaVersion: 2,
      id: v2Id,
      events: [
        { type: 'turn/start', turnId: 'schema-v2:turn:1', sequence: 1 },
        {
          type: 'user/message',
          turnId: 'schema-v2:turn:1',
          content: 'old',
          sequence: 2,
        },
        {
          type: 'turn/end',
          turnId: 'schema-v2:turn:1',
          status: 'completed',
          sequence: 3,
        },
        {
          type: 'compaction/summary',
          turnId: 'schema-v2:turn:1',
          summary: 'checkpoint',
          shadowedSequences: [2],
          summarizer: 'legacy/v2',
          sequence: 4,
        },
      ],
    }),
  )
  const migratedV2 = new FileSessionStore({ directory }).get(v2Id)
  assert.deepEqual(migratedV2?.projectMessages(), [{ role: 'user', content: 'checkpoint' }])
  assert.equal(
    (JSON.parse(readFileSync(v2Path, 'utf8')) as Record<string, unknown>).schemaVersion,
    SESSION_FILE_SCHEMA_VERSION,
  )

  const v4Id = 'schema-v4'
  const v4Path = sessionFilePath(directory, v4Id)
  writeFileSync(v4Path, JSON.stringify({ schemaVersion: 4, id: v4Id, events: [] }))
  assert.ok(new FileSessionStore({ directory }).get(v4Id))
  assert.equal(
    (JSON.parse(readFileSync(v4Path, 'utf8')) as Record<string, unknown>).schemaVersion,
    SESSION_FILE_SCHEMA_VERSION,
  )

  const v3Id = 'schema-v3'
  const v3Path = sessionFilePath(directory, v3Id)
  writeFileSync(v3Path, JSON.stringify({ schemaVersion: 3, id: v3Id, events: [] }))
  assert.ok(new FileSessionStore({ directory }).get(v3Id))
  assert.equal(
    (JSON.parse(readFileSync(v3Path, 'utf8')) as Record<string, unknown>).schemaVersion,
    SESSION_FILE_SCHEMA_VERSION,
  )

  const v5Id = 'schema-v5'
  const v5Path = sessionFilePath(directory, v5Id)
  writeFileSync(
    v5Path,
    JSON.stringify({
      schemaVersion: 5,
      id: v5Id,
      events: [
        { type: 'turn/start', turnId: 'schema-v5:turn:1', sequence: 1 },
        { type: 'step/start', turnId: 'schema-v5:turn:1', step: 1, sequence: 2 },
        {
          type: 'approval/asked',
          turnId: 'schema-v5:turn:1',
          sequence: 3,
          callId: 'call',
          name: 'write',
          risk: 'filesystem',
          reason: 'write a file',
        },
        {
          type: 'approval/decided',
          turnId: 'schema-v5:turn:1',
          sequence: 4,
          callId: 'call',
          name: 'write',
          outcome: 'rejected',
        },
        {
          type: 'step/end',
          turnId: 'schema-v5:turn:1',
          step: 1,
          outcome: 'completed',
          sequence: 5,
        },
        {
          type: 'turn/end',
          turnId: 'schema-v5:turn:1',
          status: 'completed',
          sequence: 6,
        },
      ],
    }),
  )
  assert.ok(new FileSessionStore({ directory }).get(v5Id))
  assert.equal(
    (JSON.parse(readFileSync(v5Path, 'utf8')) as Record<string, unknown>).schemaVersion,
    SESSION_FILE_SCHEMA_VERSION,
  )
})

test('command events persist log-only and interrupted commands close durably', (t) => {
  const directory = temporaryDirectory(t)
  const store = new FileSessionStore({ directory })
  const complete = store.create('complete-command')
  complete.append({
    type: 'command/run',
    turnId: 'complete-command:command:1',
    commandId: 'complete-command:command:1',
    name: 'inspect',
    rawInput: '',
  })
  complete.append({
    type: 'command/done',
    turnId: 'complete-command:command:1',
    commandId: 'complete-command:command:1',
    name: 'inspect',
    result: { kind: 'success', text: 'ready' },
  })
  const reloaded = new FileSessionStore({ directory }).get('complete-command')
  assert.deepEqual(reloaded?.events, complete.events)
  assert.deepEqual(reloaded?.projectMessages(), [])

  const interruptedId = 'interrupted-command'
  const interruptedPath = sessionFilePath(directory, interruptedId)
  writeFileSync(
    interruptedPath,
    JSON.stringify({
      schemaVersion: SESSION_FILE_SCHEMA_VERSION,
      id: interruptedId,
      events: [
        {
          type: 'command/run',
          turnId: 'interrupted-command:command:1',
          sequence: 1,
          commandId: 'interrupted-command:command:1',
          name: 'compact',
          rawInput: ' 2',
        },
      ],
    }),
  )
  const repaired = new FileSessionStore({ directory }).get(interruptedId)
  assert.deepEqual(repaired?.events.at(-1), {
    type: 'command/done',
    turnId: 'interrupted-command:command:1',
    sequence: 2,
    commandId: 'interrupted-command:command:1',
    name: 'compact',
    result: { kind: 'error', text: COMMAND_INTERRUPTED },
  })
  const afterRepair = readFileSync(interruptedPath, 'utf8')
  assert.ok(new FileSessionStore({ directory }).get(interruptedId))
  assert.equal(readFileSync(interruptedPath, 'utf8'), afterRepair)
})

test('cold startup preserves an interrupted turn and durably synthesizes balanced closers', (t) => {
  const directory = temporaryDirectory(t)
  const id = 'interrupted-tools'
  const filePath = sessionFilePath(directory, id)
  const prefix = [
    { type: 'turn/start', turnId: 'interrupted-tools:turn:1', sequence: 1 },
    {
      type: 'user/message',
      turnId: 'interrupted-tools:turn:1',
      content: 'run three tools',
      sequence: 2,
    },
    { type: 'step/start', turnId: 'interrupted-tools:turn:1', step: 1, sequence: 3 },
    {
      type: 'assistant/tool-calls',
      turnId: 'interrupted-tools:turn:1',
      sequence: 4,
      calls: [
        { id: 'completed', name: 'read', arguments: null },
        { id: 'unknown', name: 'write', arguments: { value: 1 } },
        { id: 'not-started', name: 'read', arguments: null },
      ],
    },
    {
      type: 'tool/call',
      turnId: 'interrupted-tools:turn:1',
      sequence: 5,
      call: { id: 'completed', name: 'read', arguments: null },
    },
    {
      type: 'tool/result',
      turnId: 'interrupted-tools:turn:1',
      sequence: 6,
      callId: 'completed',
      name: 'read',
      ok: true,
      output: 'done',
    },
    {
      type: 'tool/call',
      turnId: 'interrupted-tools:turn:1',
      sequence: 7,
      call: { id: 'unknown', name: 'write', arguments: { value: 1 } },
    },
  ]
  writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, id, events: prefix }))

  const session = new FileSessionStore({ directory }).get(id)
  assert.ok(session)
  assert.deepEqual(session.events.slice(0, prefix.length), prefix)
  assert.deepEqual(session.events.slice(prefix.length), [
    {
      type: 'tool/result',
      turnId: 'interrupted-tools:turn:1',
      sequence: 8,
      callId: 'unknown',
      name: 'write',
      ok: false,
      error: TOOL_OUTCOME_UNKNOWN,
    },
    {
      type: 'tool/result',
      turnId: 'interrupted-tools:turn:1',
      sequence: 9,
      callId: 'not-started',
      name: 'read',
      ok: false,
      error: TOOL_NOT_STARTED,
    },
    {
      type: 'step/end',
      turnId: 'interrupted-tools:turn:1',
      step: 1,
      outcome: 'interrupted',
      sequence: 10,
    },
    {
      type: 'turn/end',
      turnId: 'interrupted-tools:turn:1',
      status: 'interrupted',
      sequence: 11,
    },
  ])
  assert.equal(Object.isFrozen(session.events.at(-1)), true)
  assert.deepEqual(session.projectMessages().slice(-2), [
    {
      role: 'tool',
      callId: 'unknown',
      name: 'write',
      ok: false,
      error: TOOL_OUTCOME_UNKNOWN,
    },
    {
      role: 'tool',
      callId: 'not-started',
      name: 'read',
      ok: false,
      error: TOOL_NOT_STARTED,
    },
  ])

  const committed = readFileSync(filePath, 'utf8')
  const secondLoad = new FileSessionStore({ directory }).get(id)
  assert.deepEqual(secondLoad?.events, session.events)
  assert.equal(readFileSync(filePath, 'utf8'), committed)
})

test('crash repair uses safety audit to classify consequential execution', (t) => {
  const directory = temporaryDirectory(t)
  const id = 'interrupted-safety'
  const turnId = `${id}:turn:1`
  const filePath = sessionFilePath(directory, id)
  const events = [
    { type: 'turn/start', turnId, sequence: 1 },
    { type: 'user/message', turnId, content: 'write twice', sequence: 2 },
    { type: 'step/start', turnId, step: 1, sequence: 3 },
    {
      type: 'assistant/tool-calls',
      turnId,
      sequence: 4,
      calls: [
        { id: 'denied', name: 'write', arguments: null },
        { id: 'dispatched', name: 'write', arguments: null },
      ],
    },
    {
      type: 'tool/call',
      turnId,
      sequence: 5,
      call: { id: 'denied', name: 'write', arguments: null },
    },
    {
      type: 'approval/asked',
      turnId,
      sequence: 6,
      callId: 'denied',
      name: 'write',
      risk: 'filesystem',
      reason: 'write a file',
    },
    {
      type: 'approval/decided',
      turnId,
      sequence: 7,
      callId: 'denied',
      name: 'write',
      outcome: 'rejected',
    },
    {
      type: 'tool/call',
      turnId,
      sequence: 8,
      call: { id: 'dispatched', name: 'write', arguments: null },
    },
    {
      type: 'approval/asked',
      turnId,
      sequence: 9,
      callId: 'dispatched',
      name: 'write',
      risk: 'filesystem',
      reason: 'write a file',
    },
    {
      type: 'approval/decided',
      turnId,
      sequence: 10,
      callId: 'dispatched',
      name: 'write',
      outcome: 'allowed-once',
    },
    {
      type: 'sandbox/prepared',
      turnId,
      sequence: 11,
      callId: 'dispatched',
      name: 'write',
      profile: 'workspace-write',
      provider: 'container/v1',
      enforcement: 'full',
    },
  ]
  writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: SESSION_FILE_SCHEMA_VERSION,
      id,
      events,
    }),
  )

  const repaired = new FileSessionStore({ directory }).get(id)
  const results = repaired?.events.filter((event) => event.type === 'tool/result')
  assert.deepEqual(
    results?.map((event) => (event.ok ? undefined : event.error)),
    [TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN],
  )
})

test('failed crash repair leaves the original document unchanged and unpublished', (t) => {
  const directory = temporaryDirectory(t)
  const id = 'repair-failure'
  const filePath = sessionFilePath(directory, id)
  const original = JSON.stringify({
    schemaVersion: SESSION_FILE_SCHEMA_VERSION,
    id,
    events: [{ type: 'turn/start', turnId: 'repair-failure:turn:1', sequence: 1 }],
  })
  writeFileSync(filePath, original)

  assert.throws(
    () =>
      new FileSessionStore({
        directory,
        writer: () => {
          throw new SessionPersistenceError('repair storage unavailable')
        },
      }),
    /repair storage unavailable/,
  )
  assert.equal(readFileSync(filePath, 'utf8'), original)
})

test('ambiguous trailing execution structure is corruption, not repair input', (t) => {
  const directory = temporaryDirectory(t)
  const id = 'ambiguous-tail'
  const filePath = sessionFilePath(directory, id)
  const turn = { type: 'turn/start', turnId: 'turn-1', sequence: 1 }
  const step = { type: 'step/start', turnId: 'turn-1', step: 1, sequence: 2 }
  const call = {
    type: 'assistant/tool-calls',
    turnId: 'turn-1',
    sequence: 3,
    calls: [{ id: 'call-1', name: 'write', arguments: null }],
  }
  const cases: ReadonlyArray<readonly [readonly unknown[], RegExp]> = [
    [
      [{ type: 'user/message', turnId: 'turn-1', content: 'orphan', sequence: 1 }],
      /without a new turn\/start/,
    ],
    [[turn, { type: 'turn/start', turnId: 'turn-2', sequence: 2 }], /mismatched turn id/],
    [[turn, step, { ...step, sequence: 3 }], /nested step\/start/],
    [[turn, { ...call, sequence: 2 }], /outside an open step/],
    [
      [
        turn,
        step,
        {
          type: 'tool/call',
          turnId: 'turn-1',
          sequence: 3,
          call: { id: 'unknown', name: 'write', arguments: null },
        },
      ],
      /has no pending call/,
    ],
    [
      [
        turn,
        step,
        {
          type: 'tool/result',
          turnId: 'turn-1',
          sequence: 3,
          callId: 'unknown',
          name: 'write',
          ok: true,
          output: null,
        },
      ],
      /has no pending call/,
    ],
    [
      [
        turn,
        step,
        {
          type: 'step/end',
          turnId: 'turn-1',
          step: 2,
          outcome: 'completed',
          sequence: 3,
        },
      ],
      /does not match/,
    ],
    [
      [turn, { type: 'assistant/message', turnId: 'turn-1', content: 'orphan', sequence: 2 }],
      /outside an open step/,
    ],
    [
      [
        turn,
        step,
        call,
        {
          type: 'step/end',
          turnId: 'turn-1',
          step: 1,
          outcome: 'tool_calls',
          sequence: 4,
        },
      ],
      /unanswered tool calls/,
    ],
  ]

  for (const [events, expected] of cases) {
    const original = JSON.stringify({ schemaVersion: 1, id, events })
    writeFileSync(filePath, original)
    assert.throws(() => new FileSessionStore({ directory }), expected)
    assert.equal(readFileSync(filePath, 'utf8'), original)
  }
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

  writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      id,
      events: [{ type: 'turn/start', turnId: 'turn-1', sequence: 2 }],
    }),
  )
  assert.throws(() => new FileSessionStore({ directory }), /invalid envelope or sequence/)

  writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      id,
      events: [{ type: 'not-an-event', turnId: 'turn-1', sequence: 1 }],
    }),
  )
  assert.throws(() => new FileSessionStore({ directory }), /unknown type/)

  const legacyUsage = JSON.stringify({
    schemaVersion: 3,
    id,
    events: [
      {
        type: 'assistant/message',
        turnId: 'turn-1',
        sequence: 1,
        content: 'legacy',
        usage: {
          model: 'provider/model',
          inputTokens: 1,
          outputTokens: 1,
          inputSurfaceSequences: [],
          inputTools: [],
        },
      },
    ],
  })
  writeFileSync(filePath, legacyUsage)
  assert.throws(() => new FileSessionStore({ directory }), /legacy schema.*newer schema/)
  assert.equal(readFileSync(filePath, 'utf8'), legacyUsage)

  const legacySafety = JSON.stringify({
    schemaVersion: 4,
    id,
    events: [
      {
        type: 'approval/decided',
        turnId: 'turn-1',
        sequence: 1,
        callId: 'call-1',
        name: 'write',
        outcome: 'rejected',
      },
    ],
  })
  writeFileSync(filePath, legacySafety)
  assert.throws(() => new FileSessionStore({ directory }), /legacy schema.*newer schema/)
  assert.equal(readFileSync(filePath, 'utf8'), legacySafety)

  const legacyCommand = JSON.stringify({
    schemaVersion: 5,
    id,
    events: [
      {
        type: 'command/run',
        turnId: 'command-1',
        sequence: 1,
        commandId: 'command-1',
        name: 'inspect',
        rawInput: '',
      },
    ],
  })
  writeFileSync(filePath, legacyCommand)
  assert.throws(() => new FileSessionStore({ directory }), /legacy schema.*newer schema/)
  assert.equal(readFileSync(filePath, 'utf8'), legacyCommand)

  const recursiveCommandProvenance = JSON.stringify({
    schemaVersion: SESSION_FILE_SCHEMA_VERSION,
    id,
    events: [
      {
        type: 'command/run',
        turnId: 'command-1',
        sequence: 1,
        commandId: 'command-1',
        name: 'compact',
        rawInput: '',
      },
      {
        type: 'command/done',
        turnId: 'command-1',
        sequence: 2,
        commandId: 'command-1',
        name: 'compact',
        result: { kind: 'success', sourceSequence: 1 },
      },
    ],
  })
  writeFileSync(filePath, recursiveCommandProvenance)
  assert.throws(() => new FileSessionStore({ directory }), /invalid source event/)
  assert.equal(readFileSync(filePath, 'utf8'), recursiveCommandProvenance)
})

test('every persisted event variant is validated before it can become live state', (t) => {
  const directory = temporaryDirectory(t)
  const id = 'validation'
  const filePath = sessionFilePath(directory, id)
  const invalidDocuments: ReadonlyArray<readonly [unknown, RegExp]> = [
    [null, /document is not an object/],
    [{ schemaVersion: 1, id }, /string id and events array/],
    [{ type: 'user/message', turnId: 'turn-1', sequence: 1 }, /invalid content/],
    [
      {
        type: 'assistant/message',
        turnId: 'turn-1',
        sequence: 1,
        content: 'bad usage',
        usage: {
          model: 'provider/model',
          inputTokens: -1,
          outputTokens: 0,
          inputSurfaceSequences: [],
          inputTools: [],
        },
      },
      /invalid provider usage/,
    ],
    [
      {
        type: 'assistant/message',
        turnId: 'turn-1',
        sequence: 1,
        content: 'bad prompt usage',
        usage: {
          model: 'provider/model',
          inputTokens: 1,
          outputTokens: 0,
          inputSurfaceSequences: [],
          inputTools: [],
          inputSystemPrompt: 42,
        },
      },
      /invalid provider usage/,
    ],
    [{ type: 'step/start', turnId: 'turn-1', sequence: 1, step: 0 }, /invalid step number/],
    [{ type: 'assistant/tool-calls', turnId: 'turn-1', sequence: 1 }, /invalid calls/],
    [
      {
        type: 'compaction/summary',
        turnId: 'turn-1',
        sequence: 1,
        summary: '',
        shadowedSequences: [],
        summarizer: '',
      },
      /invalid provenance/,
    ],
    [
      {
        type: 'context-budget/decision',
        turnId: 'turn-1',
        sequence: 1,
        trigger: 'pressure',
        model: '',
        measuredTokens: -1,
        outcome: 'compacted',
      },
      /invalid fields/,
    ],
    [
      {
        type: 'assistant/tool-calls',
        turnId: 'turn-1',
        sequence: 1,
        calls: [{ id: 'call-1', name: 'add' }],
      },
      /invalid tool call/,
    ],
    [{ type: 'tool/call', turnId: 'turn-1', sequence: 1, call: null }, /invalid tool call/],
    [
      {
        type: 'approval/asked',
        turnId: 'turn-1',
        sequence: 1,
        callId: 'call-1',
        name: 'write',
        risk: 'safe',
        reason: '',
      },
      /approval\/asked has invalid fields/,
    ],
    [
      {
        type: 'approval/decided',
        turnId: 'turn-1',
        sequence: 1,
        callId: 'call-1',
        name: 'write',
        outcome: 'forever',
      },
      /approval\/decided has invalid fields/,
    ],
    [
      {
        type: 'sandbox/prepared',
        turnId: 'turn-1',
        sequence: 1,
        callId: 'call-1',
        name: 'write',
        profile: '',
        provider: '',
        enforcement: 'none',
      },
      /sandbox\/prepared has invalid fields/,
    ],
    [
      {
        type: 'command/run',
        turnId: 'wrong',
        sequence: 1,
        commandId: 'command-1',
        name: 'Bad',
        rawInput: 1,
      },
      /command\/run has invalid fields/,
    ],
    [
      {
        type: 'command/done',
        turnId: 'command-1',
        sequence: 1,
        commandId: 'command-1',
        name: 'inspect',
        result: { kind: 'error' },
      },
      /command\/done has invalid fields/,
    ],
    [{ type: 'tool/result', turnId: 'turn-1', sequence: 1, ok: true }, /invalid envelope/],
    [
      {
        type: 'tool/result',
        turnId: 'turn-1',
        sequence: 1,
        callId: 'call-1',
        name: 'add',
        ok: true,
      },
      /invalid output/,
    ],
    [
      {
        type: 'tool/result',
        turnId: 'turn-1',
        sequence: 1,
        callId: 'call-1',
        name: 'add',
        ok: false,
      },
      /invalid error/,
    ],
    [
      { type: 'step/end', turnId: 'turn-1', sequence: 1, step: 1, outcome: 'later' },
      /invalid outcome/,
    ],
    [{ type: 'turn/error', turnId: 'turn-1', sequence: 1 }, /invalid error/],
    [{ type: 'turn/end', turnId: 'turn-1', sequence: 1, status: 'later' }, /invalid status/],
  ]

  for (const [eventOrDocument, expected] of invalidDocuments) {
    const isDocument =
      eventOrDocument === null ||
      (typeof eventOrDocument === 'object' &&
        eventOrDocument !== null &&
        'schemaVersion' in eventOrDocument)
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
  assert.throws(
    () =>
      session.append({
        type: 'tool/result',
        turnId: 'turn-1',
        callId: 'call-1',
        name: 'add',
        ok: true,
        output: Number.NaN,
      }),
    /invalid output/,
  )
  assert.equal(session.events.length, 0)
  assert.equal(readFileSync(filePath, 'utf8'), before)
})

test('persisted compaction provenance must match the derived surface prefix', (t) => {
  const directory = temporaryDirectory(t)
  const id = 'invalid-compaction-provenance'
  const filePath = sessionFilePath(directory, id)
  const original = JSON.stringify({
    schemaVersion: SESSION_FILE_SCHEMA_VERSION,
    id,
    events: [
      { type: 'turn/start', turnId: 'turn-1', sequence: 1 },
      { type: 'user/message', turnId: 'turn-1', content: 'first', sequence: 2 },
      { type: 'assistant/message', turnId: 'turn-1', content: 'second', sequence: 3 },
      { type: 'turn/end', turnId: 'turn-1', status: 'completed', sequence: 4 },
      {
        type: 'compaction/summary',
        turnId: 'turn-1',
        sequence: 5,
        summary: 'bad checkpoint',
        shadowedSequences: [3],
        summarizer: 'test/v1',
      },
    ],
  })
  writeFileSync(filePath, original)

  assert.throws(() => new FileSessionStore({ directory }), /does not shadow.*surface prefix/)
  assert.equal(readFileSync(filePath, 'utf8'), original)

  const wrongBoundary = original
    .replace('"turnId":"turn-1","sequence":5', '"turnId":"wrong-turn","sequence":5')
    .replace('"shadowedSequences":[3]', '"shadowedSequences":[2,3]')
  writeFileSync(filePath, wrongBoundary)
  assert.throws(() => new FileSessionStore({ directory }), /not at a maintenance boundary/)
  assert.equal(readFileSync(filePath, 'utf8'), wrongBoundary)

  const legacy = JSON.stringify({
    schemaVersion: 1,
    id,
    events: [
      { type: 'turn/start', turnId: 'turn-1', sequence: 1 },
      { type: 'user/message', turnId: 'turn-1', content: 'first', sequence: 2 },
      { type: 'turn/end', turnId: 'turn-1', status: 'completed', sequence: 3 },
      {
        type: 'compaction/summary',
        turnId: 'turn-1',
        sequence: 4,
        summary: 'checkpoint',
        shadowedSequences: [2],
        summarizer: 'test/v1',
      },
    ],
  })
  writeFileSync(filePath, legacy)
  assert.throws(() => new FileSessionStore({ directory }), /legacy schema.*newer schema/)
  assert.equal(readFileSync(filePath, 'utf8'), legacy)
})

test('canonical files must match their stored IDs while unrelated and temporary files are ignored', (t) => {
  const directory = temporaryDirectory(t)
  writeFileSync(join(directory, 'notes.json'), '{}')
  writeFileSync(join(directory, '.session-orphan.tmp'), 'partial')
  const openedStore = new FileSessionStore({ directory })

  const appearedId = 'appeared-late'
  atomicReplaceFile(
    sessionFilePath(directory, appearedId),
    JSON.stringify({
      schemaVersion: 1,
      id: appearedId,
      events: [],
    }),
  )
  assert.throws(() => openedStore.create(appearedId), /changed in another process/)

  const filePath = sessionFilePath(directory, 'expected')
  writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, id: 'different', events: [] }))
  assert.throws(() => new FileSessionStore({ directory }), /filename does not match/)
})
