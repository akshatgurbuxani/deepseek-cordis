import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  discoverPersistedSessions,
  formatCliError,
  InteractiveApprovalService,
  InteractiveReplayModelAdapter,
  initializeCliProfile,
  parseCliArguments,
  resolveCliConfiguration,
  runCli,
  runCliOperator,
  runInteractiveCli,
} from '@deepseek-cordis/cli'
import { consoleTrace, type TraceSink, TracingSessionStore } from '@deepseek-cordis/cli/tracing'
import { completeModel, ModelStreamError } from '@deepseek-cordis/model'
import {
  FileSessionStore,
  SESSION_FILE_SCHEMA_VERSION,
  SessionWriteConflictError,
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
    trace: (label, value) => {
      records.push({ label, value })
    },
  }
}

function sseResponse(payloads: readonly unknown[]): Response {
  const body = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function writeProfile(directory: string, value: unknown): string {
  const filename = join(directory, 'profile.json')
  writeFileSync(filename, JSON.stringify(value, undefined, 2))
  return filename
}

test('argument parsing selects replay or OpenRouter without exposing environment values', () => {
  assert.deepEqual(parseCliArguments(['--replay', 'add', '2', 'and', '3'], {}), {
    mode: 'replay',
    interactive: false,
    quiet: false,
    input: 'add 2 and 3',
    model: 'replay/calculator',
  })
  assert.deepEqual(parseCliArguments([], { OPENROUTER_MODEL: 'provider/model' }), {
    mode: 'openrouter',
    interactive: false,
    quiet: false,
    input: 'Use the add tool to calculate 17 + 25.',
    model: 'provider/model',
  })
  assert.equal(parseCliArguments(['--interactive', '--replay'], {}).interactive, true)
  assert.equal(parseCliArguments(['--quiet'], {}).quiet, true)
  assert.equal(parseCliArguments(['--resume', 'session-1'], {}).resumeSessionId, 'session-1')
  assert.equal(parseCliArguments(['--resume=session-2'], {}).resumeSessionId, 'session-2')
  assert.equal(parseCliArguments(['--profile', 'coding.json'], {}).profilePath, 'coding.json')
  assert.equal(parseCliArguments(['--profile=coding.json'], {}).profilePath, 'coding.json')
  assert.equal(
    parseCliArguments([], { HARNESS_PROFILE: 'environment.json' }).profilePath,
    'environment.json',
  )
  assert.equal(
    parseCliArguments(['--profile', 'cli.json'], {
      HARNESS_PROFILE: 'environment.json',
    }).profilePath,
    'cli.json',
  )
  assert.throws(() => parseCliArguments(['--profile'], {}), /requires a path/)
  assert.throws(() => parseCliArguments(['--profile='], {}), /requires a path/)
  assert.throws(() => parseCliArguments(['--resume'], {}), /requires a session id/)
  assert.throws(() => parseCliArguments(['--resume='], {}), /requires a session id/)
  assert.throws(() => parseCliArguments(['--resume', 'first', '--resume=second'], {}), /only once/)
  assert.throws(() => parseCliArguments([`--resume=${'x'.repeat(257)}`], {}), /too long/)
  assert.throws(() => parseCliArguments([], { HARNESS_PROFILE: ' ' }), /non-empty path/)
  assert.equal(
    parseCliArguments(['--profile=valid.json'], {
      HARNESS_PROFILE: ' ',
    }).profilePath,
    'valid.json',
  )
  assert.throws(
    () => parseCliArguments(['--profile=same.json', '--profile=same.json'], {}),
    /only once/,
  )
  assert.throws(() => parseCliArguments(['--unknown'], {}), /unknown option "--unknown"/)
})

test('profile initialization is secure, complete, and refuses to overwrite', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-init-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'nested', 'coding.json')

  assert.equal(initializeCliProfile(filename), filename)
  assert.equal(statSync(filename).mode & 0o777, 0o600)
  const configuration = resolveCliConfiguration(parseCliArguments(['--profile', filename], {}), {})
  assert.equal(configuration.profile.name, 'coding')
  assert.equal(configuration.profile.persistence.kind, 'file')
  assert.equal(configuration.profile.tools.enabled.includes('workspace.patch'), true)
  assert.equal(configuration.profile.tools.enabled.includes('add'), false)
  const original = readFileSync(filename, 'utf8')
  assert.throws(() => initializeCliProfile(filename), /already exists; it was not changed/)
  assert.equal(readFileSync(filename, 'utf8'), original)
})

test('session discovery and model-free operators expose deterministic resumable state', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-sessions-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const profile = initializeCliProfile(join(directory, 'profile.json'))
  const configuration = resolveCliConfiguration(parseCliArguments(['--profile', profile], {}), {})
  const store = new FileSessionStore({ directory: configuration.sessionDirectory! })
  const second = store.create('second')
  second.append({ type: 'turn/start', turnId: 'second:turn:1' })
  second.append({ type: 'turn/end', turnId: 'second:turn:1', status: 'completed' })
  store.create('first')

  assert.deepEqual(discoverPersistedSessions(configuration), [
    { id: 'first', events: 0, turns: 0, lastStatus: 'empty' },
    { id: 'second', events: 2, turns: 1, lastStatus: 'completed' },
  ])
  const output: string[] = []
  assert.equal(
    runCliOperator({
      argv: ['--sessions', '--profile', profile, '--quiet'],
      env: {},
      output: (line) => output.push(line),
    }),
    true,
  )
  assert.deepEqual(output, [
    'first\tturns=0\tevents=0\tlast=empty',
    'second\tturns=1\tevents=2\tlast=completed',
  ])
  assert.throws(
    () => runCliOperator({ argv: ['--sessions', '--profile', profile, 'unexpected'], env: {} }),
    /accepts only --profile and --quiet/,
  )
})

test('help is model-free and documents every operator mode', () => {
  const output: string[] = []
  assert.equal(
    runCliOperator({ argv: ['--help'], env: {}, output: (line) => output.push(line) }),
    true,
  )
  assert.match(output[0]!, /Usage: deepseek-cordis/)
  for (const option of [
    '--profile',
    '--interactive',
    '--resume',
    '--quiet',
    '--init',
    '--sessions',
  ]) {
    assert.match(output[0]!, new RegExp(option))
  }
  assert.throws(
    () => runCliOperator({ argv: ['--help', '--quiet'], env: {} }),
    /cannot be combined/,
  )
})

test('CLI conflict errors include an actionable recovery path', () => {
  assert.match(
    String(formatCliError(new SessionWriteConflictError('SESSION_WRITE_BUSY', 'busy'))),
    /retry with --resume <session-id>/,
  )
  assert.match(
    String(formatCliError(new SessionWriteConflictError('SESSION_STALE_WRITER', 'stale'))),
    /Use --sessions.*--resume <session-id>/s,
  )
})

test('profile paths resolve at their owning layer and launch overlays win explicitly', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-profile-resolution-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const filename = writeProfile(directory, {
    schemaVersion: 1,
    name: 'profile-resolution',
    model: { provider: 'openrouter', id: 'profile/model', contextWindow: 4096 },
    workspace: { root: './workspace', maxFileBytes: 2048 },
    persistence: { kind: 'file', directory: './sessions' },
  })

  const fromProfile = resolveCliConfiguration(
    parseCliArguments(['--profile', filename, 'hello'], {}),
    {},
  )
  assert.equal(fromProfile.model, 'profile/model')
  assert.equal(fromProfile.contextWindow, 4096)
  assert.equal(fromProfile.workspaceRoot, join(directory, 'workspace'))
  assert.equal(fromProfile.sessionDirectory, join(directory, 'sessions'))
  assert.equal(fromProfile.profilePath, filename)

  const overlaid = resolveCliConfiguration(
    parseCliArguments(['--profile', filename, '--replay', 'add 1 and 2'], {
      OPENROUTER_MODEL: 'environment/model',
    }),
    {
      OPENROUTER_MODEL: 'environment/model',
      HARNESS_CONTEXT_WINDOW: '8192',
      HARNESS_WORKSPACE_ROOT: './launch-workspace',
      HARNESS_SESSION_DIR: './launch-sessions',
    },
  )
  assert.equal(overlaid.mode, 'replay')
  assert.equal(overlaid.model, 'replay/calculator')
  assert.equal(overlaid.contextWindow, 8192)
  assert.equal(overlaid.workspaceRoot, resolve('./launch-workspace'))
  assert.equal(overlaid.sessionDirectory, resolve('./launch-sessions'))
})

test('the documented coding profile remains valid and complete', () => {
  const filename = resolve('harness/cli/profile.example.json')
  const configuration = resolveCliConfiguration(parseCliArguments(['--profile', filename], {}), {})

  assert.equal(configuration.profile.name, 'coding')
  assert.equal(configuration.model, 'openrouter/free')
  assert.equal(configuration.contextWindow, 128_000)
  assert.equal(configuration.profile.tools.enabled.includes('workspace.edit'), true)
  assert.equal(configuration.profile.tools.enabled.includes('workspace.command'), true)
  assert.deepEqual(
    configuration.profile.model.provider === 'openrouter'
      ? configuration.profile.model.retry
      : undefined,
    { maxRetries: 2, initialDelayMs: 250, maxDelayMs: 5_000 },
  )
  assert.deepEqual(configuration.profile.process.allowedPrograms, [
    'git',
    'node',
    'npm',
    'npx',
    'rg',
  ])
  assert.equal(configuration.profile.approval.default, 'ask')
})

test('a profile controls the exact model, tools, and assembled prompt', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-profile-composition-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const filename = writeProfile(directory, {
    schemaVersion: 1,
    name: 'minimal-persona',
    model: {
      provider: 'openrouter',
      id: 'profile/model',
      contextWindow: 64_000,
      retry: { maxRetries: 0, initialDelayMs: 10, maxDelayMs: 20 },
      routing: {
        allowFallbacks: false,
        requireParameters: true,
        dataCollection: 'deny',
        sort: 'price',
      },
    },
    workspace: { root: './does-not-exist' },
    tools: { enabled: [] },
    prompt: {
      identity: false,
      workspaceGuidance: true,
      persona: 'Answer with verified facts only.',
    },
  })
  let body: Record<string, unknown> | undefined
  const { records, trace } = recorder()
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return sseResponse([
      {
        model: 'profile/model',
        choices: [{ delta: { content: 'Verified.' } }],
      },
    ])
  }) as typeof globalThis.fetch

  const result = await runCli({
    argv: ['--profile', filename, 'answer this'],
    env: { OPENROUTER_API_KEY: 'profile-secret' },
    fetch,
    trace,
    output: () => undefined,
    sessionId: 'profile-composition',
  })

  assert.equal(result.content, 'Verified.')
  assert.equal(body?.model, 'profile/model')
  assert.equal(body?.tools, undefined)
  assert.deepEqual(body?.provider, {
    allow_fallbacks: false,
    require_parameters: true,
    data_collection: 'deny',
    sort: 'price',
  })
  assert.deepEqual(body?.messages, [
    { role: 'system', content: 'Answer with verified facts only.' },
    { role: 'user', content: 'answer this' },
  ])
  const start = records.find(({ label }) => label === 'cli/start')?.value
  assert.deepEqual(start, {
    mode: 'openrouter',
    interactive: false,
    input: 'answer this',
    model: 'profile/model',
    profile: 'minimal-persona',
    profileSource: 'file',
    tools: [],
    approvalDefault: 'ask',
    processBackend: 'local',
    sessionId: 'profile-composition',
    sessionStore: 'memory',
    resumed: false,
  })
  assert.equal(JSON.stringify(records).includes('does-not-exist'), false)
  assert.equal(JSON.stringify(records).includes('profile-secret'), false)
})

test('workspace instructions compose through the CLI and refresh between model steps', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-instructions-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  writeFileSync(join(directory, 'AGENTS.md'), 'Use instruction version one.')
  const filename = writeProfile(directory, {
    schemaVersion: 1,
    name: 'workspace-instructions',
    model: { provider: 'openrouter', id: 'profile/model', contextWindow: 64_000 },
    workspace: { root: '.' },
    tools: { enabled: ['add'] },
    prompt: { identity: false, workspaceGuidance: false },
    instructions: { enabled: true, maxBytes: 4096 },
  })
  const bodies: Array<Record<string, unknown>> = []
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    if (bodies.length === 1) {
      writeFileSync(join(directory, 'AGENTS.md'), 'Use instruction version two.')
      return sseResponse([
        {
          model: 'profile/model',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'instruction-add',
                    type: 'function',
                    function: { name: 'add', arguments: '{"a":2,"b":3}' },
                  },
                ],
              },
            },
          ],
        },
      ])
    }
    return sseResponse([
      { model: 'profile/model', choices: [{ delta: { content: 'The answer is 5.' } }] },
    ])
  }) as typeof globalThis.fetch

  await runCli({
    argv: ['--profile', filename, 'add 2 and 3'],
    env: { OPENROUTER_API_KEY: 'instruction-secret' },
    fetch,
    trace: () => undefined,
    output: () => undefined,
    sessionId: 'workspace-instructions',
  })

  assert.equal(bodies.length, 2)
  assert.match(JSON.stringify(bodies[0]?.messages), /Use instruction version one/)
  assert.doesNotMatch(JSON.stringify(bodies[0]?.messages), /version two/)
  assert.match(JSON.stringify(bodies[1]?.messages), /Use instruction version two/)
  assert.doesNotMatch(JSON.stringify(bodies[1]?.messages), /version one/)
  assert.equal(JSON.stringify(bodies).includes(directory), false)
  assert.equal(JSON.stringify(bodies).includes('instruction-secret'), false)
})

test('profile-relative file persistence works while disabled workspace tools stay unconstructed', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-profile-persistence-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const filename = writeProfile(directory, {
    schemaVersion: 1,
    name: 'replay-persistent',
    model: { provider: 'replay' },
    workspace: { root: './missing-workspace' },
    persistence: { kind: 'file', directory: './sessions' },
    tools: { enabled: ['add'] },
  })

  await runCli({
    argv: ['--profile', filename, 'add 4 and 5'],
    env: {},
    trace: () => undefined,
    output: () => undefined,
    sessionId: 'profile-persisted',
  })

  const persisted = new FileSessionStore({ directory: join(directory, 'sessions') }).get(
    'profile-persisted',
  )
  assert.ok(persisted)
  assert.equal(persisted.events.at(-1)?.type, 'turn/end')
})

test('interactive replay runs multiple turns and direct control commands', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-interactive-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const lines = ['add 1 and 2', 'add 3 and 4', '/inspect', '/compact', '/help', '/missing', '/exit']
  const output: string[] = []
  const result = await runInteractiveCli({
    argv: ['--interactive', '--replay'],
    env: { HARNESS_SESSION_DIR: directory },
    sessionId: 'interactive-cli',
    trace: () => undefined,
    readLine: () => lines.shift(),
    output: (content) => {
      output.push(content)
    },
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
  assert.equal(
    persisted.projectMessages().some((message) => JSON.stringify(message).includes('/inspect')),
    false,
  )
})

test('interactive profile reload transactionally replaces runtime policy between turns', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-profile-reload-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const initial = {
    schemaVersion: 1,
    name: 'reloadable',
    model: { provider: 'replay' },
    workspace: { root: '.' },
    persistence: { kind: 'memory' },
    tools: { enabled: ['add'] },
    prompt: { identity: false, workspaceGuidance: false, persona: 'Persona before reload.' },
    instructions: { enabled: false },
    approval: { default: 'deny' },
  }
  const filename = writeProfile(directory, initial)
  const lines = ['add 1 and 2', '/reload', 'add 3 and 4', '/reload', '/exit']
  const launchEnv = { HARNESS_CONTEXT_WINDOW: '4096' }
  let prompt = 0
  const output: string[] = []
  const { records, trace } = recorder()

  const result = await runInteractiveCli({
    argv: ['--interactive', '--profile', filename],
    env: launchEnv,
    sessionId: 'profile-reload',
    trace,
    readLine: () => {
      prompt += 1
      if (prompt === 2) {
        launchEnv.HARNESS_CONTEXT_WINDOW = '8192'
        writeProfile(directory, {
          ...initial,
          tools: { enabled: ['add', 'workspace.read'] },
          prompt: {
            identity: false,
            workspaceGuidance: false,
            persona: 'Persona after reload.',
          },
          context: { thresholdRatio: 0.7, retainTurns: 2, maxOverflowRetries: 0 },
        })
      }
      return lines.shift()
    },
    output: (content) => {
      output.push(content)
    },
  })

  assert.deepEqual(result, { sessionId: 'profile-reload', turns: 2, commands: 3 })
  const requests = records
    .filter(({ label }) => label === 'model/request')
    .map(({ value }) => JSON.stringify(value))
  assert.equal(requests.length, 4)
  assert.ok(requests.slice(0, 2).every((request) => request.includes('Persona before reload.')))
  assert.ok(requests.slice(2).every((request) => request.includes('Persona after reload.')))
  assert.ok(requests.slice(0, 2).every((request) => !request.includes('read_workspace_file')))
  assert.ok(requests.slice(2).every((request) => request.includes('read_workspace_file')))
  const modelInfo = records.filter(({ label }) => label === 'model/info')
  assert.ok(modelInfo.length > 0)
  assert.ok(
    modelInfo.every(({ value }) => (value as { contextWindow?: number }).contextWindow === 4096),
  )
  assert.match(output.join('\n'), /Reloaded profile "reloadable"; \d+ runtime entries changed\./)
  assert.match(output.join('\n'), /Profile "reloadable" is unchanged\./)
  assert.deepEqual(
    records
      .filter(({ label }) => label === 'cli/reload')
      .map(({ value }) => (value as { status: string }).status),
    ['started', 'applied', 'started', 'unchanged'],
  )
})

test('invalid, incompatible, and unmountable reloads retain the last-known-good runtime', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-profile-reload-rejection-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const stable = {
    schemaVersion: 1,
    name: 'stable-profile',
    model: { provider: 'replay' },
    workspace: { root: '.' },
    persistence: { kind: 'memory' },
    tools: { enabled: ['add'] },
    prompt: { identity: false, workspaceGuidance: false, persona: 'Stable persona.' },
    instructions: { enabled: false },
  }
  const filename = writeProfile(directory, stable)
  const missingWorkspace = join(directory, 'missing-workspace')
  const lines = ['/reload', '/reload', '/reload', '/reload', 'add 8 and 9', '/exit']
  let prompt = 0
  const output: string[] = []
  const { records, trace } = recorder()

  await runInteractiveCli({
    argv: ['--interactive', '--profile', filename],
    env: {},
    sessionId: 'profile-reload-rejected',
    trace,
    readLine: () => {
      prompt += 1
      if (prompt === 1) writeFileSync(filename, '{ invalid')
      if (prompt === 2) {
        writeProfile(directory, {
          ...stable,
          persistence: { kind: 'file', directory: './new-sessions' },
        })
      }
      if (prompt === 3) {
        writeProfile(directory, {
          ...stable,
          workspace: { root: './missing-workspace' },
          tools: { enabled: ['add', 'workspace.read'] },
        })
      }
      if (prompt === 4) {
        writeProfile(directory, {
          ...stable,
          process: {
            backend: 'docker',
            image: 'deepseek-cordis/definitely-missing:image',
          },
          tools: { enabled: ['add', 'workspace.command'] },
        })
      }
      return lines.shift()
    },
    output: (content) => {
      output.push(content)
    },
  })

  const text = output.join('\n')
  assert.match(text, /profile reload rejected: profile\.json: invalid JSON/)
  assert.match(text, /persistence cannot change while a session is mounted/)
  assert.match(text, /workspace root does not exist or is inaccessible/)
  assert.match(text, /Docker sandbox is unavailable or not ready/)
  assert.equal(text.includes(directory), false)
  assert.equal(text.includes(missingWorkspace), false)
  const requests = records.filter(({ label }) => label === 'model/request')
  assert.equal(requests.length, 2)
  assert.ok(requests.every(({ value }) => JSON.stringify(value).includes('Stable persona.')))
  assert.deepEqual(
    records
      .filter(({ label }) => label === 'cli/reload')
      .map(({ value }) => (value as { status: string }).status),
    ['started', 'rejected', 'started', 'rejected', 'started', 'rejected', 'started', 'rejected'],
  )
})

test('reload is an argument-free operator command and fails closed without a profile', async () => {
  const output: string[] = []
  const lines = ['/reload now', '/reload', '/exit']
  const result = await runInteractiveCli({
    argv: ['--interactive', '--replay'],
    env: {},
    sessionId: 'reload-without-profile',
    trace: () => undefined,
    readLine: () => lines.shift(),
    output: (content) => {
      output.push(content)
    },
  })

  assert.deepEqual(result, { sessionId: 'reload-without-profile', turns: 0, commands: 3 })
  assert.match(output.join('\n'), /reload does not accept arguments/)
  assert.match(
    output.join('\n'),
    /reload requires a profile selected by --profile or HARNESS_PROFILE/,
  )
})

test('reload settles its admitted transaction when cancellation arrives during reconciliation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-profile-reload-cancel-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const profile = {
    schemaVersion: 1,
    name: 'atomic-reload',
    model: { provider: 'replay' },
    tools: { enabled: ['add'] },
    prompt: { identity: false, workspaceGuidance: false, persona: 'Before.' },
    instructions: { enabled: false },
  }
  const filename = writeProfile(directory, profile)
  const controller = new AbortController()
  const output: string[] = []
  let reloadStarted = false
  const trace: TraceSink = (label, value) => {
    if (label === 'cli/reload' && (value as { status?: string }).status === 'started') {
      reloadStarted = true
    }
    if (
      reloadStarted &&
      label === 'runtime/fiber' &&
      (value as { to?: string }).to === 'UNLOADING'
    ) {
      controller.abort(new Error('cancel during reconciliation'))
    }
  }

  const result = await runInteractiveCli({
    argv: ['--interactive', '--profile', filename],
    env: {},
    sessionId: 'atomic-reload',
    signal: controller.signal,
    trace,
    readLine: () => {
      writeProfile(directory, {
        ...profile,
        prompt: { identity: false, workspaceGuidance: false, persona: 'After.' },
      })
      return '/reload'
    },
    output: (content) => {
      output.push(content)
    },
  })

  assert.equal(controller.signal.aborted, true)
  assert.deepEqual(result, { sessionId: 'atomic-reload', turns: 0, commands: 1 })
  assert.match(output.join('\n'), /Reloaded profile "atomic-reload"/)
  assert.doesNotMatch(output.join('\n'), /command cancelled/)
})

test('interactive approval maps channel answers and fails closed', async () => {
  const request = {
    sessionId: 'session',
    turnId: 'turn',
    callId: 'call',
    toolName: 'write',
    arguments: { path: 'note.txt' },
    risk: 'filesystem' as const,
    reason: 'write a file',
  }
  let presented: unknown
  assert.equal(
    await new InteractiveApprovalService((value) => {
      presented = value
      return true
    }).request(request),
    'allowed-once',
  )
  assert.deepEqual(presented, request)
  assert.equal(Object.isFrozen(presented), true)
  assert.equal(Object.isFrozen((presented as { arguments: unknown }).arguments), true)
  assert.equal(await new InteractiveApprovalService(() => false).request(request), 'rejected')
  assert.equal(await new InteractiveApprovalService(() => undefined).request(request), 'cancelled')
  assert.equal(
    await new InteractiveApprovalService(() => {
      throw new Error('channel closed')
    }).request(request),
    'unavailable',
  )

  const controller = new AbortController()
  const pending = new InteractiveApprovalService(async () => {
    controller.abort({ kind: 'user' })
    return true
  })
  assert.equal(await pending.request({ ...request, signal: controller.signal }), 'cancelled')

  const thrownController = new AbortController()
  assert.equal(
    await new InteractiveApprovalService(() => {
      thrownController.abort({ kind: 'user' })
      throw new Error('closed while cancelling')
    }).request({ ...request, signal: thrownController.signal }),
    'cancelled',
  )

  const alreadyCancelled = new AbortController()
  alreadyCancelled.abort(new Error('already cancelled'))
  await assert.rejects(
    new InteractiveApprovalService(() => true).request({
      ...request,
      signal: alreadyCancelled.signal,
    }),
    /already cancelled/,
  )
})

test('interactive replay reports invalid and unsupported conversation states', async () => {
  const model = new InteractiveReplayModelAdapter(128)
  assert.equal(model.contextWindow, 128)
  const base = {
    sessionId: 'replay',
    turnId: 'replay:turn:1',
    step: 1,
    tools: [],
  }
  assert.deepEqual(
    await completeModel(model, {
      ...base,
      messages: [{ role: 'user', content: 'no operands' }],
    }),
    { type: 'message', content: 'Replay mode expects two numbers.' },
  )
  await assert.rejects(
    completeModel(model, {
      ...base,
      messages: [{ role: 'assistant', content: 'unexpected' }],
    }),
    (error) =>
      error instanceof ModelStreamError && /unsupported conversation state/.test(error.message),
  )
})

test('console and session tracing expose events while preserving store ownership rules', () => {
  const lines: unknown[][] = []
  const directories: unknown[] = []
  const originalLog = console.log
  const originalDir = console.dir
  console.log = (...values: unknown[]) => {
    lines.push(values)
  }
  console.dir = (value: unknown) => {
    directories.push(value)
  }
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
    output: (content) => {
      output.push(content)
    },
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
  assert.ok(
    records.some(
      ({ label, value }) =>
        label === 'session/event' && JSON.stringify(value).includes('tool/result'),
    ),
  )
  assert.ok(
    records.some(
      ({ label, value }) => label === 'runtime/fiber' && JSON.stringify(value).includes('DISPOSED'),
    ),
  )
  assert.equal(records.at(-1)?.label, 'runtime/fiber')
})

test('file-backed CLI resumes the same session across fresh application boots', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
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

test('explicit resume selects an existing persisted session and rejects unsafe ambiguity', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-explicit-resume-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const env = { HARNESS_SESSION_DIR: directory }

  await runCli({
    argv: ['--replay', 'add 1 and 2'],
    env,
    trace: () => undefined,
    output: () => undefined,
    sessionId: 'chosen',
  })
  const resumed = await runCli({
    argv: ['--quiet', '--resume=chosen', '--replay', 'add 3 and 4'],
    env,
    output: () => undefined,
  })
  assert.equal(resumed.turnId, 'chosen:turn:2')

  await assert.rejects(
    runCli({
      argv: ['--resume', 'missing', '--replay', 'add 1 and 2'],
      env,
      trace: () => undefined,
      output: () => undefined,
    }),
    /was not found; use --sessions/,
  )
  await assert.rejects(
    runCli({
      argv: ['--resume', 'chosen', '--replay', 'add 1 and 2'],
      env: {},
      trace: () => undefined,
      output: () => undefined,
    }),
    /requires file persistence/,
  )
})

test('file-backed CLI applies profile context policy before the next request', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-budget-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const profile = writeProfile(directory, {
    schemaVersion: 1,
    name: 'small-context',
    model: { provider: 'replay', contextWindow: 40 },
    persistence: { kind: 'file', directory: './sessions' },
    tools: { enabled: ['add'] },
    context: { thresholdRatio: 0.5, retainTurns: 2, maxOverflowRetries: 0 },
  })
  const argv = (left: number, right: number) => ['--profile', profile, `add ${left} and ${right}`]
  const baseEnv = { HARNESS_SESSION_ID: 'budget-cli' }
  await runCli({
    argv: argv(1, 2),
    env: baseEnv,
    trace: () => undefined,
    output: () => undefined,
  })
  await runCli({
    argv: argv(3, 4),
    env: baseEnv,
    trace: () => undefined,
    output: () => undefined,
  })
  await runCli({
    argv: argv(5, 6),
    env: baseEnv,
    trace: () => undefined,
    output: () => undefined,
  })
  const { records, trace } = recorder()

  const result = await runCli({
    argv: argv(7, 8),
    env: baseEnv,
    trace,
    output: () => undefined,
  })

  assert.equal(result.turnId, 'budget-cli:turn:4')
  const resumed = new FileSessionStore({ directory: join(directory, 'sessions') }).get('budget-cli')
  assert.ok(resumed)
  assert.equal(
    resumed.events.some((event) => event.type === 'compaction/summary'),
    true,
  )
  const decision = resumed.events.find(
    (event) => event.type === 'context-budget/decision' && event.outcome === 'compacted',
  )
  assert.ok(decision?.type === 'context-budget/decision')
  assert.equal(decision.outcome, 'compacted')
  assert.equal(decision.contextWindow, 40)
  assert.equal(decision.thresholdTokens, 20)
  assert.ok(
    records.some(
      ({ label, value }) =>
        label === 'model/request' &&
        JSON.stringify(value).includes('Earlier conversation compacted for replay.'),
    ),
  )
})

test('file-backed CLI repairs an interrupted cold turn before resuming', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-repair-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const id = 'repair-cli'
  writeFileSync(
    sessionFilePath(directory, id),
    JSON.stringify({
      schemaVersion: SESSION_FILE_SCHEMA_VERSION,
      id,
      events: [
        { type: 'turn/start', turnId: 'repair-cli:turn:1', sequence: 1 },
        {
          type: 'user/message',
          turnId: 'repair-cli:turn:1',
          content: 'interrupted work',
          sequence: 2,
        },
        { type: 'step/start', turnId: 'repair-cli:turn:1', step: 1, sequence: 3 },
        {
          type: 'assistant/tool-calls',
          turnId: 'repair-cli:turn:1',
          sequence: 4,
          calls: [{ id: 'old-call', name: 'write', arguments: null }],
        },
        {
          type: 'tool/call',
          turnId: 'repair-cli:turn:1',
          sequence: 5,
          call: { id: 'old-call', name: 'write', arguments: null },
        },
      ],
    }),
  )
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
  assert.ok(
    records.some(
      ({ label, value }) =>
        label === 'model/request' && JSON.stringify(value).includes(TOOL_OUTCOME_UNKNOWN),
    ),
  )
})

test('live-mode composition maps a tool round trip and never traces its API key', async () => {
  const { records, trace } = recorder()
  const bodies: Array<Record<string, unknown>> = []
  let call = 0
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/api/v1/models')) {
      return new Response(
        JSON.stringify({
          data: [{ id: 'openrouter/free', context_length: 64_000 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    bodies.push(JSON.parse(String(init?.body)))
    call += 1
    return call === 1
      ? sseResponse([
          {
            model: 'selected/tool-model',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'live-add',
                      type: 'function',
                      function: { name: 'add', arguments: '{"a":8' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: ',"b":9}' },
                    },
                  ],
                },
              },
            ],
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
    output: (content) => {
      output.push(content)
    },
    onTextDelta: (delta) => {
      deltas.push(delta)
    },
    sessionId: 'openrouter-cli',
  })

  assert.equal(result.content, 'The answer is 17.')
  assert.deepEqual(output, ['The answer is 17.'])
  assert.deepEqual(deltas, ['The answer ', 'is 17.'])
  assert.equal(bodies.length, 2)
  assert.ok(Array.isArray(bodies[0]?.tools))
  assert.equal(bodies[0]?.stream, true)
  assert.deepEqual(bodies[0]?.stream_options, { include_usage: true })
  assert.ok(
    records.some(
      ({ label, value }) =>
        label === 'model/info' && JSON.stringify(value).includes('"contextWindow":64000'),
    ),
  )
  assert.ok(
    records.some(
      ({ label, value }) =>
        label === 'session/event' && JSON.stringify(value).includes('"inputTokens":14'),
    ),
  )
  const secondMessages = bodies[1]?.messages as Array<Record<string, unknown>>
  assert.equal(secondMessages[0]?.role, 'system')
  assert.match(String(secondMessages[0]?.content), /DeepSeek Cordis Harness/)
  assert.match(String(secondMessages[0]?.content), /Before creating a file, stat it/)
  assert.deepEqual(secondMessages.slice(1), [
    { role: 'user', content: 'add 8 and 9' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'live-add',
          type: 'function',
          function: { name: 'add', arguments: '{"a":8,"b":9}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'live-add', content: '17' },
  ])
  assert.ok(records.some(({ label }) => label === 'openrouter/diagnostics'))
  assert.equal(JSON.stringify(records).includes('super-secret-key'), false)
})

test('interactive live mode approves and audits a confined workspace file creation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-workspace-'))
  const sessionDirectory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-workspace-session-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  t.after(() => {
    rmSync(sessionDirectory, { recursive: true, force: true })
  })
  let completion = 0
  const fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/api/v1/models')) {
      return new Response(
        JSON.stringify({
          data: [{ id: 'workspace/model', context_length: 64_000 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    completion += 1
    return completion === 1
      ? sseResponse([
          {
            model: 'workspace/model',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'create-call',
                      type: 'function',
                      function: {
                        name: 'create_workspace_file',
                        arguments: '{"path":"created.txt","content":"from the agent\\n"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ])
      : sseResponse([
          {
            model: 'workspace/model',
            choices: [{ delta: { content: 'Created the workspace file.' } }],
          },
        ])
  }) as typeof globalThis.fetch
  const lines = ['create the requested file', '/exit']
  const output: string[] = []
  const approvalPrompts: string[] = []

  const result = await runInteractiveCli({
    argv: ['--interactive'],
    env: {
      OPENROUTER_API_KEY: 'workspace-secret',
      OPENROUTER_MODEL: 'workspace/model',
      HARNESS_WORKSPACE_ROOT: directory,
      HARNESS_SESSION_DIR: sessionDirectory,
    },
    fetch,
    trace: () => undefined,
    output: (content) => {
      output.push(content)
    },
    readLine: (prompt) => {
      if (prompt.startsWith('[approval]')) {
        approvalPrompts.push(prompt)
        return 'yes'
      }
      return lines.shift()
    },
    sessionId: 'workspace-cli',
  })

  assert.deepEqual(result, { sessionId: 'workspace-cli', turns: 1, commands: 1 })
  assert.equal(readFileSync(join(directory, 'created.txt'), 'utf8'), 'from the agent\n')
  assert.match(output.join('\n'), /Created the workspace file/)
  assert.equal(approvalPrompts.length, 1)
  assert.match(approvalPrompts[0]!, /create_workspace_file \(filesystem\)/)
  assert.match(approvalPrompts[0]!, /"path":"created\.txt"/)
  assert.match(approvalPrompts[0]!, /"content":"from the agent\\n"/)
  const persisted = new FileSessionStore({ directory: sessionDirectory }).get('workspace-cli')
  assert.ok(persisted)
  assert.deepEqual(
    persisted.events.find((event) => event.type === 'sandbox/prepared'),
    {
      type: 'sandbox/prepared',
      turnId: 'workspace-cli:turn:1',
      sequence: 8,
      callId: 'create-call',
      name: 'create_workspace_file',
      profile: 'workspace-create-file',
      provider: 'workspace-file/node-path-v1',
      enforcement: 'partial',
    },
  )
  assert.deepEqual(
    persisted.events.find((event) => event.type === 'tool/result'),
    {
      type: 'tool/result',
      turnId: 'workspace-cli:turn:1',
      sequence: 9,
      callId: 'create-call',
      name: 'create_workspace_file',
      ok: true,
      output: { path: 'created.txt', bytesWritten: 15, created: true },
    },
  )
})

test('interactive live mode reads before an exact guarded workspace edit', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-edit-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  writeFileSync(join(directory, 'notes.txt'), 'status: old\n')
  let completion = 0
  const fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/api/v1/models')) {
      return new Response(
        JSON.stringify({
          data: [{ id: 'workspace/model', context_length: 64_000 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    completion += 1
    if (completion === 1) {
      return sseResponse([
        {
          model: 'workspace/model',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'read-call',
                    type: 'function',
                    function: { name: 'read_workspace_file', arguments: '{"path":"notes.txt"}' },
                  },
                ],
              },
            },
          ],
        },
      ])
    }
    if (completion === 2) {
      return sseResponse([
        {
          model: 'workspace/model',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'edit-call',
                    type: 'function',
                    function: {
                      name: 'edit_workspace_file',
                      arguments: '{"path":"notes.txt","oldText":"old","newText":"complete"}',
                    },
                  },
                ],
              },
            },
          ],
        },
      ])
    }
    return sseResponse([
      {
        model: 'workspace/model',
        choices: [{ delta: { content: 'Updated the observed file.' } }],
      },
    ])
  }) as typeof globalThis.fetch
  const lines = ['update the status', '/exit']
  const approvals: string[] = []

  const result = await runInteractiveCli({
    argv: ['--interactive'],
    env: {
      OPENROUTER_API_KEY: 'workspace-secret',
      OPENROUTER_MODEL: 'workspace/model',
      HARNESS_WORKSPACE_ROOT: directory,
    },
    fetch,
    trace: () => undefined,
    output: () => undefined,
    readLine: (prompt) => {
      if (prompt.startsWith('[approval]')) {
        approvals.push(prompt)
        return 'yes'
      }
      return lines.shift()
    },
    sessionId: 'workspace-edit-cli',
  })

  assert.deepEqual(result, { sessionId: 'workspace-edit-cli', turns: 1, commands: 1 })
  assert.equal(readFileSync(join(directory, 'notes.txt'), 'utf8'), 'status: complete\n')
  assert.equal(approvals.length, 2)
  assert.match(approvals[0]!, /read_workspace_file/)
  assert.match(approvals[1]!, /edit_workspace_file/)
  assert.equal(completion, 3)
})

test('interactive live mode runs an approved argv command with a scrubbed environment', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-command-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const bodies: Array<Record<string, unknown>> = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/api/v1/models')) {
      return new Response(
        JSON.stringify({ data: [{ id: 'workspace/model', context_length: 64_000 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return bodies.length === 1
      ? sseResponse([
          {
            model: 'workspace/model',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'command-call',
                      type: 'function',
                      function: {
                        name: 'run_workspace_command',
                        arguments: JSON.stringify({
                          program: 'node',
                          args: [
                            '-e',
                            'console.log(process.env.OPENROUTER_API_KEY ?? "environment-clean")',
                          ],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
        ])
      : sseResponse([
          {
            model: 'workspace/model',
            choices: [{ delta: { content: 'Command completed with a clean environment.' } }],
          },
        ])
  }) as typeof globalThis.fetch
  const lines = ['run the check', '/exit']
  const approvals: string[] = []

  const result = await runInteractiveCli({
    argv: ['--interactive'],
    env: {
      OPENROUTER_API_KEY: 'must-not-reach-command',
      OPENROUTER_MODEL: 'workspace/model',
      HARNESS_WORKSPACE_ROOT: directory,
      PATH: process.env.PATH,
    },
    fetch,
    trace: () => undefined,
    output: () => undefined,
    readLine: (prompt) => {
      if (prompt.startsWith('[approval]')) {
        approvals.push(prompt)
        return 'yes'
      }
      return lines.shift()
    },
    sessionId: 'workspace-command-cli',
  })

  assert.deepEqual(result, { sessionId: 'workspace-command-cli', turns: 1, commands: 1 })
  assert.equal(approvals.length, 1)
  assert.match(approvals[0]!, /run_workspace_command \(shell\)/)
  const messages = bodies[1]?.messages as Array<Record<string, unknown>>
  const toolMessage = messages.find((message) => message.role === 'tool')
  assert.match(String(toolMessage?.content), /environment-clean/)
  assert.equal(String(toolMessage?.content).includes('must-not-reach-command'), false)
  assert.match(String((messages[0] as { content?: string }).content), /Workspace command policy/)
})

test('a deny-default profile never invokes the interactive approval channel', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-profile-deny-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const filename = writeProfile(directory, {
    schemaVersion: 1,
    name: 'deny-workspace',
    model: { provider: 'openrouter', id: 'profile/deny', contextWindow: 64_000 },
    workspace: { root: '.' },
    tools: { enabled: ['workspace.create'] },
    approval: { default: 'deny' },
  })
  let completion = 0
  const fetch = (async () => {
    completion += 1
    return completion === 1
      ? sseResponse([
          {
            model: 'profile/deny',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'denied-create',
                      type: 'function',
                      function: {
                        name: 'create_workspace_file',
                        arguments: '{"path":"must-not-exist.txt","content":"blocked"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ])
      : sseResponse([
          {
            model: 'profile/deny',
            choices: [{ delta: { content: 'The operation was unavailable.' } }],
          },
        ])
  }) as typeof globalThis.fetch
  const lines = ['create it', '/exit']
  const approvalPrompts: string[] = []
  const { records, trace } = recorder()

  await runInteractiveCli({
    argv: ['--interactive', '--profile', filename],
    env: { OPENROUTER_API_KEY: 'deny-secret' },
    fetch,
    trace,
    output: () => undefined,
    readLine: (prompt) => {
      if (prompt.startsWith('[approval]')) approvalPrompts.push(prompt)
      return lines.shift()
    },
    sessionId: 'profile-deny',
  })

  assert.deepEqual(approvalPrompts, [])
  assert.equal(existsSync(join(directory, 'must-not-exist.txt')), false)
  assert.equal(
    records.some(
      ({ label, value }) =>
        label === 'session/event' && JSON.stringify(value).includes('"outcome":"rejected"'),
    ),
    true,
  )
  assert.equal(JSON.stringify(records).includes('deny-secret'), false)
})

test('CLI cancellation records an aborted turn and drains every mounted fiber', async () => {
  const { records, trace } = recorder()
  const controller = new AbortController()
  const fetch = (async () =>
    sseResponse([
      { choices: [{ delta: { content: 'partial' } }] },
      { choices: [{ delta: { content: ' text' } }] },
    ])) as typeof globalThis.fetch

  await assert.rejects(
    runCli({
      argv: ['cancel this'],
      env: { OPENROUTER_API_KEY: 'cancel-secret' },
      fetch,
      trace,
      output: () => {
        assert.fail('cancelled turn must not print a final response')
      },
      onTextDelta: () => {
        controller.abort({ kind: 'user' })
      },
      signal: controller.signal,
      sessionId: 'cancel-cli',
    }),
    (error) => error instanceof Error && error.name === 'TurnCancelledError',
  )

  assert.ok(
    records.some(
      ({ label, value }) =>
        label === 'session/event' && JSON.stringify(value).includes('"status":"aborted"'),
    ),
  )
  assert.equal(
    records.some(({ label }) => label === 'cli/result'),
    false,
  )
  assert.ok(
    records.some(
      ({ label, value }) => label === 'runtime/fiber' && JSON.stringify(value).includes('DISPOSED'),
    ),
  )
  assert.equal(JSON.stringify(records).includes('cancel-secret'), false)
})

test('configuration and provider failures reject while still draining mounted fibers', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-invalid-profile-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const invalidProfile = writeProfile(directory, {
    schemaVersion: 1,
    tools: { enabled: ['shell'] },
  })
  const invalidTrace = recorder()
  await assert.rejects(
    runCli({
      argv: ['--profile', invalidProfile, 'hello'],
      env: { OPENROUTER_API_KEY: 'unused-secret' },
      trace: invalidTrace.trace,
      output: () => undefined,
    }),
    /not a recognized tool id/,
  )
  assert.deepEqual(invalidTrace.records, [])

  const unavailableDockerProfile = writeProfile(directory, {
    schemaVersion: 1,
    model: { provider: 'replay' },
    process: {
      backend: 'docker',
      image: 'deepseek-cordis/definitely-missing:image',
    },
    tools: { enabled: ['workspace.command'] },
  })
  await assert.rejects(
    runCli({
      argv: ['--profile', unavailableDockerProfile, 'add 1 and 2'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      trace: () => undefined,
      output: () => undefined,
    }),
    /Docker sandbox is unavailable or not ready/,
  )

  const missingKeyTrace = recorder()
  await assert.rejects(
    runCli({
      argv: ['hello'],
      env: {},
      trace: missingKeyTrace.trace,
      output: () => undefined,
    }),
    /API key is required/,
  )
  assert.equal(JSON.stringify(missingKeyTrace.records).includes('OPENROUTER'), false)

  const failedTrace = recorder()
  const failedFetch = (async () =>
    new Response('provider unavailable', {
      status: 503,
    })) as typeof globalThis.fetch
  await assert.rejects(
    runCli({
      argv: ['add 1 and 2'],
      env: { OPENROUTER_API_KEY: 'failure-secret' },
      fetch: failedFetch,
      trace: failedTrace.trace,
      output: () => undefined,
      sessionId: 'failed-cli',
    }),
    /OpenRouter request failed \(503\): provider unavailable/,
  )

  assert.ok(
    failedTrace.records.some(
      ({ label, value }) => label === 'runtime/fiber' && JSON.stringify(value).includes('DISPOSED'),
    ),
  )
  assert.equal(JSON.stringify(failedTrace.records).includes('failure-secret'), false)
})

test('replay mode requires two numeric operands and supports the default prompt', async () => {
  await assert.rejects(
    runCli({
      argv: ['--replay', 'no arithmetic here'],
      env: {},
      trace: () => undefined,
      output: () => undefined,
    }),
    /at least two numbers/,
  )

  const output: string[] = []
  const result = await runCli({
    argv: ['--replay'],
    env: {},
    trace: () => undefined,
    output: (content) => {
      output.push(content)
    },
    sessionId: 'default-replay',
  })
  assert.equal(result.content, 'The answer is 42.')
  assert.deepEqual(output, ['The answer is 42.'])
})

test('process entry point prints replay output and exits non-zero for invalid arguments', () => {
  const success = spawnSync(
    process.execPath,
    ['harness/cli/dist/main.js', '--replay', 'add 3 and 4'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {},
    },
  )
  assert.equal(success.status, 0, success.stderr)
  assert.match(success.stdout, /The answer is 7\./)
  assert.match(success.stdout, /to: 'DISPOSED'/)

  const quiet = spawnSync(
    process.execPath,
    ['harness/cli/dist/main.js', '--quiet', '--replay', 'add 8 and 9'],
    { cwd: process.cwd(), encoding: 'utf8', env: {} },
  )
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.equal(quiet.stdout, 'The answer is 17.\n')

  const interactive = spawnSync(
    process.execPath,
    ['harness/cli/dist/main.js', '--interactive', '--replay'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {},
      input: 'add 4 and 5\n/exit\n',
    },
  )
  assert.equal(interactive.status, 0, interactive.stderr)
  assert.match(interactive.stdout, /The answer is 9\./)
  assert.match(interactive.stdout, /Session closed\./)

  const failure = spawnSync(process.execPath, ['harness/cli/dist/main.js', '--unknown'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {},
  })
  assert.equal(failure.status, 1)
  assert.match(failure.stderr, /\[cli\/error\]/)
  assert.match(failure.stderr, /unknown option "--unknown"/)
})

test('process entry point initializes a profile without model credentials', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-cli-main-init-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'configuration', 'profile.json')
  const result = spawnSync(process.execPath, ['harness/cli/dist/main.js', '--init', filename], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {},
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^Created /)
  assert.equal(existsSync(filename), true)

  const help = spawnSync(process.execPath, ['harness/cli/dist/main.js', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {},
  })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /Usage: deepseek-cordis/)
})
