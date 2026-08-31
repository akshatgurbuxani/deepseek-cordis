import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import type { SandboxRequest } from '@deepseek-cordis/sandbox'
import {
  createWorkspaceFileTool,
  DEFAULT_MAX_FILE_BYTES,
  WORKSPACE_CREATE_FILE_TOOL,
  WORKSPACE_WRITE_PROFILE,
  WorkspaceFileSandbox,
  WorkspaceFileSandboxError,
} from '@deepseek-cordis/sandbox-workspace'
import { InMemoryToolRegistry, type ToolSafetyAuditEvent } from '@deepseek-cordis/tools'

function temporaryDirectory(t: TestContext, prefix = 'deepseek-cordis-workspace-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

function request(
  argumentsValue: SandboxRequest['arguments'],
  signal?: AbortSignal,
): SandboxRequest {
  return {
    sessionId: 'session',
    turnId: 'turn',
    callId: 'call',
    toolName: WORKSPACE_CREATE_FILE_TOOL,
    arguments: argumentsValue,
    risk: 'filesystem',
    profile: WORKSPACE_WRITE_PROFILE,
    ...(signal ? { signal } : {}),
  }
}

test('a prepared lease creates one file atomically and never overwrites', async (t) => {
  const root = temporaryDirectory(t)
  mkdirSync(join(root, 'notes'))
  const sandbox = new WorkspaceFileSandbox({ root })
  const preparation = await sandbox.prepare(
    request({
      path: 'notes/result.txt',
      content: 'complete ✓\n',
    }),
  )

  assert.equal(preparation.ok, true)
  if (!preparation.ok) return
  assert.equal(preparation.lease.provider, 'workspace-file/node-path-v1')
  assert.equal(preparation.lease.enforcement, 'partial')
  assert.equal(readdirSync(join(root, 'notes')).length, 0)
  assert.deepEqual(await preparation.lease.execute(), {
    path: 'notes/result.txt',
    bytesWritten: 13,
    created: true,
  })
  assert.equal(readFileSync(join(root, 'notes/result.txt'), 'utf8'), 'complete ✓\n')
  assert.deepEqual(readdirSync(join(root, 'notes')), ['result.txt'])
  await assert.rejects(preparation.lease.execute(), /no longer executable/)
  preparation.lease.dispose()
  preparation.lease.dispose()

  const duplicate = await sandbox.prepare(request({ path: 'notes/result.txt', content: 'replace' }))
  assert.deepEqual(duplicate, { ok: false, reason: 'workspace file target already exists' })
  assert.equal(readFileSync(join(root, 'notes/result.txt'), 'utf8'), 'complete ✓\n')
})

test('request and path validation fail closed before a lease exists', async (t) => {
  const root = temporaryDirectory(t)
  writeFileSync(join(root, 'plain'), 'not a directory')
  const sandbox = new WorkspaceFileSandbox({ root, maxFileBytes: 4 })

  const unsupported = await sandbox.prepare({
    ...request({ path: 'file', content: 'ok' }),
    toolName: 'other',
  })
  assert.deepEqual(unsupported, {
    ok: false,
    reason: 'workspace sandbox does not support this operation',
  })
  assert.equal(
    (
      await sandbox.prepare({
        ...request({ path: 'file', content: 'ok' }),
        profile: 'other',
      })
    ).ok,
    false,
  )
  assert.equal(
    (
      await sandbox.prepare({
        ...request({ path: 'file', content: 'ok' }),
        risk: 'shell',
      })
    ).ok,
    false,
  )

  const cases: ReadonlyArray<readonly [SandboxRequest['arguments'], RegExp]> = [
    [null, /only path and content strings/],
    [{ path: 'file' }, /only path and content strings/],
    [{ path: 'file', content: 'ok', extra: true }, /only path and content strings/],
    [{ path: '', content: '' }, /portable relative path/],
    [{ path: '/absolute', content: '' }, /portable relative path/],
    [{ path: '../escape', content: '' }, /invalid segment/],
    [{ path: 'a//b', content: '' }, /invalid segment/],
    [{ path: 'a\\b', content: '' }, /portable relative path/],
    [{ path: 'a\0b', content: '' }, /portable relative path/],
    [{ path: 'missing/file', content: '' }, /parent directory does not exist/],
    [{ path: 'plain/file', content: '' }, /parent is not a directory/],
    [{ path: 'large', content: '12345' }, /exceeds 4 bytes/],
  ]
  for (const [argumentsValue, expected] of cases) {
    const result = await sandbox.prepare(request(argumentsValue))
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.reason, expected)
  }
  assert.equal(readdirSync(root).sort().join(','), 'plain')

  assert.throws(() => new WorkspaceFileSandbox({ root, maxFileBytes: 0 }), /positive integer/)
  assert.equal(new WorkspaceFileSandbox({ root }).maxFileBytes, DEFAULT_MAX_FILE_BYTES)
  assert.throws(
    () => new WorkspaceFileSandbox({ root: join(root, 'plain') }),
    /workspace root must be a directory/,
  )
  assert.throws(
    () => new WorkspaceFileSandbox({ root: join(root, 'missing-root') }),
    /does not exist or is inaccessible/,
  )
})

test('symbolic links cannot redirect the operation outside the workspace', async (t) => {
  const root = temporaryDirectory(t)
  const outside = temporaryDirectory(t, 'deepseek-cordis-outside-')
  mkdirSync(join(root, 'safe'))
  symlinkSync(outside, join(root, 'linked-dir'))
  symlinkSync(join(outside, 'target.txt'), join(root, 'linked-target'))
  const sandbox = new WorkspaceFileSandbox({ root })

  const linkedParent = await sandbox.prepare(
    request({
      path: 'linked-dir/escaped.txt',
      content: 'escape',
    }),
  )
  assert.deepEqual(linkedParent, {
    ok: false,
    reason: 'workspace file path crosses a symbolic link',
  })
  const linkedTarget = await sandbox.prepare(request({ path: 'linked-target', content: 'escape' }))
  assert.deepEqual(linkedTarget, {
    ok: false,
    reason: 'workspace file target already exists',
  })
  assert.deepEqual(readdirSync(outside), [])
})

test('execution revalidates races and observes cancellation before the effect', async (t) => {
  const root = temporaryDirectory(t)
  const sandbox = new WorkspaceFileSandbox({ root })
  const raced = await sandbox.prepare(request({ path: 'race.txt', content: 'model' }))
  assert.equal(raced.ok, true)
  if (!raced.ok) return
  writeFileSync(join(root, 'race.txt'), 'host')
  await assert.rejects(raced.lease.execute(), WorkspaceFileSandboxError)
  assert.equal(readFileSync(join(root, 'race.txt'), 'utf8'), 'host')
  raced.lease.dispose()

  const controller = new AbortController()
  const cancelled = await sandbox.prepare(
    request(
      {
        path: 'cancelled.txt',
        content: 'never',
      },
      controller.signal,
    ),
  )
  assert.equal(cancelled.ok, true)
  if (!cancelled.ok) return
  controller.abort(new Error('cancelled by user'))
  await assert.rejects(cancelled.lease.execute(), /cancelled by user/)
  assert.equal(readdirSync(root).includes('cancelled.txt'), false)

  const disposed = await sandbox.prepare(request({ path: 'disposed.txt', content: 'never' }))
  assert.equal(disposed.ok, true)
  if (!disposed.ok) return
  disposed.lease.dispose()
  await assert.rejects(disposed.lease.execute(), /no longer executable/)
  assert.equal(readdirSync(root).includes('disposed.txt'), false)

  const preCancelled = new AbortController()
  preCancelled.abort(new Error('already cancelled'))
  await assert.rejects(
    sandbox.prepare(request({ path: 'never.txt', content: '' }, preCancelled.signal)),
    /already cancelled/,
  )
})

test('the consequential tool composes approval, audit, and the real provider', async (t) => {
  const root = temporaryDirectory(t)
  const sandbox = new WorkspaceFileSandbox({ root })
  const tools = new InMemoryToolRegistry()
  tools.register(createWorkspaceFileTool())
  const audits: ToolSafetyAuditEvent[] = []
  const execution = await tools.execute(
    WORKSPACE_CREATE_FILE_TOOL,
    {
      path: 'approved.txt',
      content: 'approved',
    },
    {
      context: { sessionId: 'session', turnId: 'turn', callId: 'call' },
      approval: { request: async () => 'allowed-once' },
      sandbox,
      audit: (event) => {
        audits.push(event)
      },
    },
  )

  assert.deepEqual(execution, {
    ok: true,
    output: { path: 'approved.txt', bytesWritten: 8, created: true },
  })
  assert.equal(readFileSync(join(root, 'approved.txt'), 'utf8'), 'approved')
  assert.deepEqual(
    audits.map((event) => event.type),
    ['approval/asked', 'approval/decided', 'sandbox/prepared'],
  )
  assert.deepEqual(audits.at(-1), {
    type: 'sandbox/prepared',
    callId: 'call',
    name: WORKSPACE_CREATE_FILE_TOOL,
    profile: WORKSPACE_WRITE_PROFILE,
    provider: 'workspace-file/node-path-v1',
    enforcement: 'partial',
  })

  const rejected = await tools.execute(
    WORKSPACE_CREATE_FILE_TOOL,
    {
      path: 'rejected.txt',
      content: 'rejected',
    },
    {
      context: { sessionId: 'session', turnId: 'turn', callId: 'call-2' },
      approval: { request: async () => 'rejected' },
      sandbox,
      audit() {},
    },
  )
  assert.equal(rejected.ok, false)
  assert.equal(readdirSync(root).includes('rejected.txt'), false)
})
