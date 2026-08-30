import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { completeModel, ModelStreamError } from '@deepseek-cordis/model'
import {
  InteractiveApprovalService,
  InteractiveReplayModelAdapter,
  parseCliArguments,
  runCli,
  runInteractiveCli,
} from '@deepseek-cordis/cli'
import {
  consoleTrace,
  type TraceSink,
  TracingSessionStore,
} from '@deepseek-cordis/cli/tracing'
import {
  FileSessionStore,
  SESSION_FILE_SCHEMA_VERSION,
  sessionFilePath,
  TOOL_OUTCOME_UNKNOWN,
} from '@deepseek-cordis/session-file'

interface TraceRecord {
  readonly label: string
  readonly value: unknown
}

function recorder(): { readonly records: TraceRecord[]; readonly trace: TraceSink } {
  const records: TraceRecord[] = []
  return {
    records,
    trace: (label, value) => { records.push({ label, value }) },
  }
}

function sseResponse(payloads: readonly unknown[]): Response {
  const body = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')
    + 'data: [DONE]\n\n'
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

test('argument parsing selects replay or OpenRouter without exposing environment values', () => {
  assert.deepEqual(parseCliArguments(['--replay', 'add', '2', 'and', '3'], {}), {
    mode: 'replay',
    interactive: false,
    input: 'add 2 and 3',
    model: 'replay/calculator',
  })
  assert.deepEqual(parseCliArguments([], { OPENROUTER_MODEL: 'provider/model' }), {
    mode: 'openrouter',
    interactive: false,
    input: 'Use the add tool to calculate 17 + 25.',
    model: 'provider/model',
  })
  assert.equal(parseCliArguments(['--interactive', '--replay'], {}).interactive, true)
  assert.throws(() => parseCliArguments(['--unknown'], {}), /unknown option "--unknown"/)
})

test('interactive replay runs multiple turns and direct control commands', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-interactive-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const lines = [
    'add 1 and 2',
    'add 3 and 4',
    '/inspect',
    '/compact',
    '/help',
    '/missing',
    '/exit',
  ]
  const output: string[] = []
  const result = await runInteractiveCli({
    argv: ['--interactive', '--replay'],
    env: { HARNESS_SESSION_DIR: directory },
    sessionId: 'interactive-cli',
    trace: () => undefined,
    readLine: () => lines.shift(),
    output: (content) => { output.push(content) },
  })

  assert.deepEqual(result, { sessionId: 'interactive-cli', turns: 2, commands: 4 })
  assert.match(output.join('\n'), /The answer is 3\./)
  assert.match(output.join('\n'), /The answer is 7\./)
  assert.match(output.join('\n'), /Session: interactive-cli/)
  assert.match(output.join('\n'), /Compacted \d+ model-visible messages/)
  assert.match(output.join('\n'), /\/inspect/)
  assert.match(output.join('\n'), /Unknown command/)
  assert.equal(output.at(-1), 'Session closed.')

  const persisted = new FileSessionStore({ directory }).get('interactive-cli')
  assert.ok(persisted)
  assert.equal(persisted.events.filter((event) => event.type === 'command/run').length, 4)
  assert.equal(persisted.events.filter((event) => event.type === 'command/done').length, 4)
  assert.equal(persisted.projectMessages().some((message) =>
    JSON.stringify(message).includes('/inspect')), false)
})

test('interactive approval maps channel answers and fails closed', async () => {
  const request = {
    sessionId: 'session', turnId: 'turn', callId: 'call', toolName: 'write',
    risk: 'filesystem' as const, reason: 'write a file',
  }
  let presented: unknown
  assert.equal(await new InteractiveApprovalService((value) => {
    presented = value
    return true
  }).request(request), 'allowed-once')
  assert.deepEqual(presented, request)
  assert.equal(Object.isFrozen(presented), true)
  assert.equal(
    await new InteractiveApprovalService(() => false).request(request),
    'rejected',
  )
  assert.equal(
    await new InteractiveApprovalService(() => undefined).request(request),
    'cancelled',
  )
  assert.equal(
    await new InteractiveApprovalService(() => { throw new Error('channel closed') })
      .request(request),
    'unavailable',
  )

  const controller = new AbortController()
  const pending = new InteractiveApprovalService(async () => {
    controller.abort({ kind: 'user' })
    return true
  })
  assert.equal(await pending.request({ ...request, signal: controller.signal }), 'cancelled')

  const thrownController = new AbortController()
  assert.equal(await new InteractiveApprovalService(() => {
    thrownController.abort({ kind: 'user' })
    throw new Error('closed while cancelling')
  }).request({ ...request, signal: thrownController.signal }), 'cancelled')

  const alreadyCancelled = new AbortController()
  alreadyCancelled.abort(new Error('already cancelled'))
  await assert.rejects(
    new InteractiveApprovalService(() => true)
      .request({ ...request, signal: alreadyCancelled.signal }),
    /already cancelled/,
  )
})

test('interactive replay reports invalid and unsupported conversation states', async () => {
  const model = new InteractiveReplayModelAdapter(128)
  assert.equal(model.contextWindow, 128)
  const base = {
    sessionId: 'replay', turnId: 'replay:turn:1', step: 1, tools: [],
  }
  assert.deepEqual(await completeModel(model, {
    ...base, messages: [{ role: 'user', content: 'no operands' }],
  }), { type: 'message', content: 'Replay mode expects two numbers.' })
  await assert.rejects(completeModel(model, {
    ...base, messages: [{ role: 'assistant', content: 'unexpected' }],
  }), (error) => error instanceof ModelStreamError
    && /unsupported conversation state/.test(error.message))
})

test('console and session tracing expose events while preserving store ownership rules', () => {
  const lines: unknown[][] = []
  const directories: unknown[] = []
  const originalLog = console.log
  const originalDir = console.dir
  console.log = (...values: unknown[]) => { lines.push(values) }
  console.dir = (value: unknown) => { directories.push(value) }
  try {
    consoleTrace('visible', { value: 1 })
  } finally {
    console.log = originalLog
    console.dir = originalDir
  }
  assert.deepEqual(lines, [['\n[visible]']])
  assert.deepEqual(directories, [{ value: 1 }])

  const { records, trace } = recorder()
  const sessions = new TracingSessionStore(trace)
  const session = sessions.create('owned')
  session.append({ type: 'turn/start', turnId: 'owned:turn:1' })
  assert.equal(sessions.get('owned'), session)
  assert.equal(records[0]?.label, 'session/event')
  assert.throws(() => sessions.create('owned'), /already exists/)
})

test('replay CLI runs a complete turn, prints the answer, traces it, and fully disposes', async () => {
  const { records, trace } = recorder()
  const output: string[] = []

  const result = await runCli({
    argv: ['--replay', 'Please add -4.5 and 10'],
    env: {},
    trace,
    output: (content) => { output.push(content) },
    sessionId: 'replay-cli',
  })

  assert.deepEqual(result, {
    turnId: 'replay-cli:turn:1',
    content: 'The answer is 5.5.',
    steps: 2,
  })
  assert.deepEqual(output, ['The answer is 5.5.'])
  assert.equal(records[0]?.label, 'cli/start')
  assert.ok(records.some(({ label }) => label === 'model/request'))
  assert.ok(records.some(({ label }) => label === 'model/response'))
  assert.ok(records.some(({ label, value }) =>
    label === 'session/event'
    && JSON.stringify(value).includes('tool/result')))
  assert.ok(records.some(({ label, value }) =>
    label === 'runtime/fiber'
    && JSON.stringify(value).includes('DISPOSED')))
  assert.equal(records.at(-1)?.label, 'runtime/fiber')
})

test('file-backed CLI resumes the same session across fresh application boots', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const firstTrace = recorder()
  const secondTrace = recorder()
  const env = { HARNESS_SESSION_DIR: directory, HARNESS_SESSION_ID: 'persistent-cli' }

  const first = await runCli({
    argv: ['--replay', 'add 2 and 3'],
    env,
    trace: firstTrace.trace,
    output: () => undefined,
  })
  const second = await runCli({
    argv: ['--replay', 'add 4 and 5'],
    env,
    trace: secondTrace.trace,
    output: () => undefined,
  })

  assert.equal(first.turnId, 'persistent-cli:turn:1')
  assert.equal(second.turnId, 'persistent-cli:turn:2')
  assert.match(JSON.stringify(firstTrace.records[0]?.value), /"resumed":false/)
  assert.match(JSON.stringify(secondTrace.records[0]?.value), /"resumed":true/)

  const resumed = new FileSessionStore({ directory }).get('persistent-cli')
  assert.ok(resumed)
  assert.equal(resumed.events.filter((event) => event.type === 'turn/start').length, 2)
  assert.deepEqual(
    resumed.projectMessages().filter((message) => message.role === 'user'),
    [
      { role: 'user', content: 'add 2 and 3' },
      { role: 'user', content: 'add 4 and 5' },
    ],
  )
})

test('file-backed CLI applies configured context pressure before the next request', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-budget-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const baseEnv = { HARNESS_SESSION_DIR: directory, HARNESS_SESSION_ID: 'budget-cli' }
  await runCli({
    argv: ['--replay', 'add 1 and 2'], env: baseEnv,
    trace: () => undefined, output: () => undefined,
  })
  await runCli({
    argv: ['--replay', 'add 3 and 4'], env: baseEnv,
    trace: () => undefined, output: () => undefined,
  })
  const { records, trace } = recorder()

  const result = await runCli({
    argv: ['--replay', 'add 5 and 6'],
    env: { ...baseEnv, HARNESS_CONTEXT_WINDOW: '40' },
    trace,
    output: () => undefined,
  })

  assert.equal(result.turnId, 'budget-cli:turn:3')
  const resumed = new FileSessionStore({ directory }).get('budget-cli')
  assert.ok(resumed)
  assert.equal(resumed.events.some((event) => event.type === 'compaction/summary'), true)
  const decision = resumed.events.find((event) => event.type === 'context-budget/decision')
  assert.ok(decision?.type === 'context-budget/decision')
  assert.equal(decision.outcome, 'compacted')
  assert.equal(decision.contextWindow, 40)
  assert.ok(records.some(({ label, value }) =>
    label === 'model/request'
    && JSON.stringify(value).includes('Earlier conversation compacted for replay.')))
})

test('file-backed CLI repairs an interrupted cold turn before resuming', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-repair-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const id = 'repair-cli'
  writeFileSync(sessionFilePath(directory, id), JSON.stringify({
    schemaVersion: SESSION_FILE_SCHEMA_VERSION,
    id,
    events: [
      { type: 'turn/start', turnId: 'repair-cli:turn:1', sequence: 1 },
      {
        type: 'user/message', turnId: 'repair-cli:turn:1',
        content: 'interrupted work', sequence: 2,
      },
      { type: 'step/start', turnId: 'repair-cli:turn:1', step: 1, sequence: 3 },
      {
        type: 'assistant/tool-calls', turnId: 'repair-cli:turn:1', sequence: 4,
        calls: [{ id: 'old-call', name: 'write', arguments: null }],
      },
      {
        type: 'tool/call', turnId: 'repair-cli:turn:1', sequence: 5,
        call: { id: 'old-call', name: 'write', arguments: null },
      },
    ],
  }))
  const { records, trace } = recorder()

  const result = await runCli({
    argv: ['--replay', 'add 6 and 7'],
    env: { HARNESS_SESSION_DIR: directory, HARNESS_SESSION_ID: id },
    trace,
    output: () => undefined,
  })

  assert.equal(result.turnId, 'repair-cli:turn:2')
  const resumed = new FileSessionStore({ directory }).get(id)
  assert.ok(resumed)
  assert.deepEqual(
    resumed.events.filter((event) => event.type === 'turn/end').map((event) => event.status),
    ['interrupted', 'completed'],
  )
  assert.ok(records.some(({ label, value }) =>
    label === 'model/request'
    && JSON.stringify(value).includes(TOOL_OUTCOME_UNKNOWN)))
})

test('live-mode composition maps a tool round trip and never traces its API key', async () => {
  const { records, trace } = recorder()
  const bodies: Array<Record<string, unknown>> = []
  let call = 0
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/api/v1/models')) {
      return new Response(JSON.stringify({
        data: [{ id: 'openrouter/free', context_length: 64_000 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    bodies.push(JSON.parse(String(init?.body)))
    call += 1
    return call === 1
      ? sseResponse([
          {
            model: 'selected/tool-model',
            choices: [{ delta: { tool_calls: [{
              index: 0,
              id: 'live-add',
              type: 'function',
              function: { name: 'add', arguments: '{"a":8' },
            }] } }],
          },
          {
            choices: [{ delta: { tool_calls: [{
              index: 0,
              function: { arguments: ',"b":9}' },
            }] } }],
          },
          {
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
            openrouter_metadata: { strategy: 'free' },
          },
        ])
      : sseResponse([
          { model: 'selected/tool-model', choices: [{ delta: { content: 'The answer ' } }] },
          { choices: [{ delta: { content: 'is 17.' } }] },
          {
            choices: [],
            usage: { prompt_tokens: 14, completion_tokens: 4, total_tokens: 18 },
          },
        ])
  }) as typeof globalThis.fetch
  const output: string[] = []
  const deltas: string[] = []

  const result = await runCli({
    argv: ['add 8 and 9'],
    env: {
      OPENROUTER_API_KEY: 'super-secret-key',
      OPENROUTER_MODEL: 'openrouter/free',
      OPENROUTER_HTTP_REFERER: 'https://example.test',
      OPENROUTER_APP_TITLE: 'CLI test',
    },
    fetch,
    trace,
    output: (content) => { output.push(content) },
    onTextDelta: (delta) => { deltas.push(delta) },
    sessionId: 'openrouter-cli',
  })

  assert.equal(result.content, 'The answer is 17.')
  assert.deepEqual(output, ['The answer is 17.'])
  assert.deepEqual(deltas, ['The answer ', 'is 17.'])
  assert.equal(bodies.length, 2)
  assert.ok(Array.isArray(bodies[0]?.tools))
  assert.equal(bodies[0]?.stream, true)
  assert.deepEqual(bodies[0]?.stream_options, { include_usage: true })
  assert.ok(records.some(({ label, value }) =>
    label === 'model/info'
    && JSON.stringify(value).includes('"contextWindow":64000')))
  assert.ok(records.some(({ label, value }) =>
    label === 'session/event'
    && JSON.stringify(value).includes('"inputTokens":14')))
  assert.deepEqual(bodies[1]?.messages, [
    { role: 'user', content: 'add 8 and 9' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'live-add',
        type: 'function',
        function: { name: 'add', arguments: '{"a":8,"b":9}' },
      }],
    },
    { role: 'tool', tool_call_id: 'live-add', content: '17' },
  ])
  assert.ok(records.some(({ label }) => label === 'openrouter/diagnostics'))
  assert.equal(JSON.stringify(records).includes('super-secret-key'), false)
})

test('CLI cancellation records an aborted turn and drains every mounted fiber', async () => {
  const { records, trace } = recorder()
  const controller = new AbortController()
  const fetch = (async () => sseResponse([
    { choices: [{ delta: { content: 'partial' } }] },
    { choices: [{ delta: { content: ' text' } }] },
  ])) as typeof globalThis.fetch

  await assert.rejects(runCli({
    argv: ['cancel this'],
    env: { OPENROUTER_API_KEY: 'cancel-secret' },
    fetch,
    trace,
    output: () => { assert.fail('cancelled turn must not print a final response') },
    onTextDelta: () => { controller.abort({ kind: 'user' }) },
    signal: controller.signal,
    sessionId: 'cancel-cli',
  }), (error) => error instanceof Error && error.name === 'TurnCancelledError')

  assert.ok(records.some(({ label, value }) =>
    label === 'session/event'
    && JSON.stringify(value).includes('"status":"aborted"')))
  assert.equal(records.some(({ label }) => label === 'cli/result'), false)
  assert.ok(records.some(({ label, value }) =>
    label === 'runtime/fiber'
    && JSON.stringify(value).includes('DISPOSED')))
  assert.equal(JSON.stringify(records).includes('cancel-secret'), false)
})

test('configuration and provider failures reject while still draining mounted fibers', async () => {
  const missingKeyTrace = recorder()
  await assert.rejects(runCli({
    argv: ['hello'],
    env: {},
    trace: missingKeyTrace.trace,
    output: () => undefined,
  }), /API key is required/)
  assert.equal(JSON.stringify(missingKeyTrace.records).includes('OPENROUTER'), false)

  const failedTrace = recorder()
  const failedFetch = (async () => new Response('provider unavailable', {
    status: 503,
  })) as typeof globalThis.fetch
  await assert.rejects(runCli({
    argv: ['add 1 and 2'],
    env: { OPENROUTER_API_KEY: 'failure-secret' },
    fetch: failedFetch,
    trace: failedTrace.trace,
    output: () => undefined,
    sessionId: 'failed-cli',
  }), /OpenRouter request failed \(503\): provider unavailable/)

  assert.ok(failedTrace.records.some(({ label, value }) =>
    label === 'runtime/fiber'
    && JSON.stringify(value).includes('DISPOSED')))
  assert.equal(JSON.stringify(failedTrace.records).includes('failure-secret'), false)
})

test('replay mode requires two numeric operands and supports the default prompt', async () => {
  await assert.rejects(runCli({
    argv: ['--replay', 'no arithmetic here'],
    env: {},
    trace: () => undefined,
    output: () => undefined,
  }), /at least two numbers/)

  const output: string[] = []
  const result = await runCli({
    argv: ['--replay'],
    env: {},
    trace: () => undefined,
    output: (content) => { output.push(content) },
    sessionId: 'default-replay',
  })
  assert.equal(result.content, 'The answer is 42.')
  assert.deepEqual(output, ['The answer is 42.'])
})

test('process entry point prints replay output and exits non-zero for invalid arguments', () => {
  const success = spawnSync(process.execPath, [
    'harness/cli/dist/main.js',
    '--replay',
    'add 3 and 4',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {},
  })
  assert.equal(success.status, 0, success.stderr)
  assert.match(success.stdout, /The answer is 7\./)
  assert.match(success.stdout, /to: 'DISPOSED'/)

  const interactive = spawnSync(process.execPath, [
    'harness/cli/dist/main.js',
    '--interactive',
    '--replay',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {},
    input: 'add 4 and 5\n/exit\n',
  })
  assert.equal(interactive.status, 0, interactive.stderr)
  assert.match(interactive.stdout, /The answer is 9\./)
  assert.match(interactive.stdout, /Session closed\./)

  const failure = spawnSync(process.execPath, [
    'harness/cli/dist/main.js',
    '--unknown',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {},
  })
  assert.equal(failure.status, 1)
  assert.match(failure.stderr, /\[cli\/error\]/)
  assert.match(failure.stderr, /unknown option "--unknown"/)
})
