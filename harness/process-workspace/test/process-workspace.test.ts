import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import type { ProcessRunner } from '@deepseek-cordis/process'
import {
  commandEnvironment,
  createWorkspaceCommandTool,
  NodeWorkspaceProcessRunner,
  WORKSPACE_COMMAND_PROFILE,
  WORKSPACE_COMMAND_PROMPT_SECTION,
  WORKSPACE_COMMAND_TOOL,
  WorkspaceCommandSandbox,
} from '@deepseek-cordis/process-workspace'
import type { JsonValue } from '@deepseek-cordis/protocol'

function request(argumentsValue: JsonValue) {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    callId: 'call-1',
    toolName: WORKSPACE_COMMAND_TOOL,
    arguments: argumentsValue,
    risk: 'shell' as const,
    profile: WORKSPACE_COMMAND_PROFILE,
  }
}

test('the Node runner uses argv, confines cwd, and returns nonzero exits as data', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'deepseek-cordis-process-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'nested'))
  const program = basename(process.execPath)
  const runner = new NodeWorkspaceProcessRunner({
    root,
    allowedPrograms: [program],
    environment: commandEnvironment(process.env),
  })

  const result = await runner.run({
    program,
    args: ['-e', 'console.log(process.argv[1]); process.exitCode = 7', '$(not-a-shell)'],
    cwd: 'nested',
    timeoutMs: 5_000,
  })
  assert.equal(result.stdout.text, '$(not-a-shell)\n')
  assert.equal(result.exitCode, 7)
  assert.equal(result.timedOut, false)
  assert.equal(result.cwd, 'nested')
  await assert.rejects(
    runner.run({ program, args: [], cwd: '../outside', timeoutMs: 1_000 }),
    /invalid path segment/,
  )
  await assert.rejects(
    runner.run({ program: 'definitely-not-allowed', args: [], cwd: '.', timeoutMs: 1_000 }),
    /not allowed/,
  )
})

test('the Node runner bounds output, rejects symlink cwd, and terminates on timeout', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'deepseek-cordis-process-bounds-'))
  const outside = mkdtempSync(join(tmpdir(), 'deepseek-cordis-process-outside-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const program = basename(process.execPath)
  const runner = new NodeWorkspaceProcessRunner({
    root,
    allowedPrograms: [program],
    environment: commandEnvironment(process.env),
    maxOutputBytes: 32,
    killGraceMs: 50,
  })

  const output = await runner.run({
    program,
    args: ['-e', "process.stdout.write('x'.repeat(200) + 'TAIL')"],
    cwd: '.',
    timeoutMs: 5_000,
  })
  assert.equal(Buffer.byteLength(output.stdout.text) <= 32, true)
  assert.equal(output.stdout.text.endsWith('TAIL'), true)
  assert.equal(output.stdout.truncated, true)
  await assert.rejects(
    runner.run({ program, args: [], cwd: 'link', timeoutMs: 1_000 }),
    /symbolic link/,
  )

  const timed = await runner.run({
    program,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: '.',
    timeoutMs: 25,
  })
  assert.equal(timed.timedOut, true)
  assert.notEqual(timed.signal, null)
})

test('the Node runner terminates on cancellation and normalizes spawn failures', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'deepseek-cordis-process-cancel-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const program = basename(process.execPath)
  const missing = 'deepseek-cordis-definitely-missing-command'
  const runner = new NodeWorkspaceProcessRunner({
    root,
    allowedPrograms: [program, missing],
    environment: commandEnvironment(process.env),
    killGraceMs: 50,
  })
  const controller = new AbortController()
  const running = runner.run({
    program,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: '.',
    timeoutMs: 5_000,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(new Error('cancel command')), 25)
  await assert.rejects(running, /cancel command/)

  await assert.rejects(
    runner.run({ program: missing, args: [], cwd: '.', timeoutMs: 1_000 }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PROCESS_SPAWN_FAILED')
      assert.equal((error as Error).message, 'command could not be started')
      assert.equal((error as Error).message.includes(root), false)
      return true
    },
  )
})

test('sandbox preparation validates, caps timeouts, and issues a single-use exact lease', async () => {
  const seen: unknown[] = []
  const runner: ProcessRunner = {
    async run(candidate) {
      seen.push(candidate)
      return {
        program: candidate.program,
        args: candidate.args,
        cwd: candidate.cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: { text: 'ok\n', truncated: false },
        stderr: { text: '', truncated: false },
      }
    },
  }
  const sandbox = new WorkspaceCommandSandbox({ runner, timeoutMs: 100, maxTimeoutMs: 200 })
  const prepared = await sandbox.prepare(
    request({ program: 'npm', args: ['test'], cwd: 'packages/app', timeoutMs: 500 }),
  )
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.lease.enforcement, 'partial')
  assert.deepEqual(await prepared.lease.execute(), {
    program: 'npm',
    args: ['test'],
    cwd: 'packages/app',
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: { text: 'ok\n', truncated: false },
    stderr: { text: '', truncated: false },
  })
  await assert.rejects(prepared.lease.execute(), /only once/)
  prepared.lease.dispose()
  assert.equal((seen[0] as { timeoutMs: number }).timeoutMs, 200)

  assert.deepEqual(await sandbox.prepare(request({ program: 'npm', unknown: true })), {
    ok: false,
    reason: 'command arguments contain unknown field "unknown"',
  })
})

test('tool and prompt expose structured command behavior only when selected', async () => {
  const tool = createWorkspaceCommandTool()
  assert.equal(tool.name, WORKSPACE_COMMAND_TOOL)
  assert.equal(tool.safety.risk, 'shell')
  assert.equal(tool.safety.sandbox.requiredEnforcement, 'partial')
  const render = WORKSPACE_COMMAND_PROMPT_SECTION.text
  assert.equal(typeof render, 'function')
  if (typeof render !== 'function') return
  assert.equal(await render({ tools: [], sessionId: 's', turnId: 't', step: 1 }), '')
  const text = await render({
    tools: [tool],
    sessionId: 's',
    turnId: 't',
    step: 1,
  })
  assert.match(text, /argument vector/)
  assert.match(text, /exitCode/)
})

test('command environments omit ambient credentials and relative PATH entries', () => {
  assert.deepEqual(
    commandEnvironment({
      PATH: `/usr/bin${process.platform === 'win32' ? ';' : ':'}.${process.platform === 'win32' ? ';' : ':'}/bin`,
      HOME: '/home/example',
      OPENROUTER_API_KEY: 'secret',
    }),
    {
      NO_COLOR: '1',
      TERM: 'dumb',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      CI: '1',
      HOME: '/home/example',
      PATH: process.platform === 'win32' ? '/usr/bin;/bin' : '/usr/bin:/bin',
    },
  )
})
