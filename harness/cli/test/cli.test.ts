import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseCliArguments, runCli } from '@deepseek-cordis/cli'
import {
  consoleTrace,
  type TraceSink,
  TracingSessionStore,
} from '@deepseek-cordis/cli/tracing'
import { FileSessionStore } from '@deepseek-cordis/session-file'

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
    input: 'add 2 and 3',
    model: 'replay/calculator',
  })
  assert.deepEqual(parseCliArguments([], { OPENROUTER_MODEL: 'provider/model' }), {
    mode: 'openrouter',
    input: 'Use the add tool to calculate 17 + 25.',
    model: 'provider/model',
  })
  assert.throws(() => parseCliArguments(['--unknown'], {}), /unknown option "--unknown"/)
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

test('live-mode composition maps a tool round trip and never traces its API key', async () => {
  const { records, trace } = recorder()
  const bodies: Array<Record<string, unknown>> = []
  let call = 0
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
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
