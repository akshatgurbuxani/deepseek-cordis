import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { FileSystemError, type FileTarget } from '@deepseek-cordis/filesystem'
import {
  createWorkspaceFilesystemTools,
  NodeWorkspaceFileSystem,
  WorkspaceFilesystemSandbox,
  WORKSPACE_EDIT_FILE_TOOL,
  WORKSPACE_FILESYSTEM_PROFILE,
  WORKSPACE_LIST_DIRECTORY_TOOL,
  WORKSPACE_READ_FILE_TOOL,
  WORKSPACE_STAT_PATH_TOOL,
  WORKSPACE_WRITE_FILE_TOOL,
} from '@deepseek-cordis/filesystem-workspace'
import type { JsonValue } from '@deepseek-cordis/protocol'
import type { SandboxRequest } from '@deepseek-cordis/sandbox'
import { InMemoryToolRegistry } from '@deepseek-cordis/tools'

function temporaryDirectory(t: TestContext, prefix = 'deepseek-cordis-fs-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  return directory
}

test('provider resolves opaque targets and returns bounded deterministic observations', async (t) => {
  const root = temporaryDirectory(t)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'b.txt'), 'bravo')
  writeFileSync(join(root, 'src', 'a.txt'), 'alpha ✓')
  mkdirSync(join(root, 'src', 'nested'))
  const filesystem = new NodeWorkspaceFileSystem({ root })

  const listing = await filesystem.list(filesystem.resolve('src'), { maxEntries: 2 })
  assert.deepEqual(listing, {
    path: 'src',
    entries: [{ name: 'a.txt', kind: 'file' }, { name: 'b.txt', kind: 'file' }],
    truncated: true,
  })
  const read = await filesystem.readText(filesystem.resolve('src/a.txt'), { maxBytes: 20 })
  assert.equal(read.content, 'alpha ✓')
  assert.equal(read.bytes, 9)
  assert.match(read.version, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(await filesystem.stat(filesystem.resolve('src/a.txt')), {
    path: 'src/a.txt', kind: 'file', bytes: 9, version: read.version,
  })
  const rootStat = await filesystem.stat(filesystem.resolve('.'))
  assert.equal(rootStat.path, '.')
  assert.equal(rootStat.kind, 'directory')
  assert.equal(typeof rootStat.bytes, 'number')
  assert.equal(rootStat.version, null)
  await assert.rejects(
    filesystem.readText(filesystem.resolve('src/a.txt'), { maxBytes: 4 }),
    (error: unknown) => error instanceof FileSystemError && error.code === 'FS_TOO_LARGE',
  )
})

test('provider rejects traversal, foreign targets, links, binary input, and invalid roots', async (t) => {
  const root = temporaryDirectory(t)
  const outside = temporaryDirectory(t, 'deepseek-cordis-fs-outside-')
  mkdirSync(join(root, 'safe'))
  writeFileSync(join(root, 'plain'), 'plain')
  symlinkSync(outside, join(root, 'linked'))
  writeFileSync(join(root, 'nul'), Buffer.from([97, 0, 98]))
  writeFileSync(join(root, 'invalid'), Buffer.from([0xc3, 0x28]))
  const filesystem = new NodeWorkspaceFileSystem({ root, maxFileBytes: 10 })

  for (const path of ['', '../outside', '/absolute', 'a//b', 'a\\b', 'a/./b']) {
    assert.throws(() => filesystem.resolve(path), /FS_SANDBOX_DENIED/)
  }
  await assert.rejects(filesystem.stat(filesystem.resolve('linked')), /FS_SANDBOX_DENIED/)
  await assert.rejects(filesystem.list(filesystem.resolve('plain'), { maxEntries: 1 }), /FS_NOT_DIRECTORY/)
  await assert.rejects(filesystem.readText(filesystem.resolve('safe'), { maxBytes: 10 }), /FS_NOT_REGULAR_FILE/)
  await assert.rejects(
    filesystem.writeText(filesystem.resolve('.'), 'x', { expectedVersion: null }),
    /workspace root cannot be written/,
  )
  await assert.rejects(
    filesystem.writeText(filesystem.resolve('missing/file'), 'x', { expectedVersion: null }),
    /FS_NOT_FOUND/,
  )
  await assert.rejects(
    filesystem.writeText(filesystem.resolve('plain/file'), 'x', { expectedVersion: null }),
    /FS_NOT_DIRECTORY/,
  )
  await assert.rejects(
    filesystem.writeText(filesystem.resolve('missing'), 'x', { expectedVersion: 'version' }),
    /FS_STALE_VERSION/,
  )
  await assert.rejects(
    filesystem.writeText(filesystem.resolve('safe'), 'x', { expectedVersion: 'version' }),
    /FS_NOT_REGULAR_FILE/,
  )
  await assert.rejects(
    filesystem.writeText(filesystem.resolve('linked/escape'), 'x', { expectedVersion: null }),
    /FS_SANDBOX_DENIED/,
  )
  await assert.rejects(filesystem.readText(filesystem.resolve('nul'), { maxBytes: 10 }), /FS_NOT_TEXT/)
  await assert.rejects(filesystem.readText(filesystem.resolve('invalid'), { maxBytes: 10 }), /FS_NOT_TEXT/)
  await assert.rejects(
    filesystem.stat({ key: 'forged', displayPath: 'safe' } as FileTarget),
    /target belongs to another provider/,
  )
  await assert.rejects(
    filesystem.writeText(filesystem.resolve('large'), '12345678901', { expectedVersion: null }),
    /FS_TOO_LARGE/,
  )
  assert.throws(() => new NodeWorkspaceFileSystem({ root, maxFileBytes: 0 }), /positive integer/)
  assert.throws(() => new NodeWorkspaceFileSystem({ root: join(root, 'missing') }), /FS_NOT_FOUND/)
  assert.throws(() => new NodeWorkspaceFileSystem({ root: join(root, 'plain') }), /FS_NOT_DIRECTORY/)
})

test('version guards prevent stale writes and edit is exact and atomic', async (t) => {
  const root = temporaryDirectory(t)
  writeFileSync(join(root, 'notes.txt'), 'one two three')
  const filesystem = new NodeWorkspaceFileSystem({ root })
  const target = filesystem.resolve('notes.txt')
  const observed = await filesystem.readText(target, { maxBytes: 100 })

  writeFileSync(join(root, 'notes.txt'), 'host change')
  await assert.rejects(
    filesystem.writeText(target, 'model change', { expectedVersion: observed.version }),
    /FS_STALE_VERSION/,
  )
  assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'host change')

  chmodSync(join(root, 'notes.txt'), 0o744)
  const permissionVersion = (await filesystem.stat(target)).version
  assert.ok(permissionVersion)
  const edited = await filesystem.editText(target, 'host', 'model', {
    expectedVersion: permissionVersion,
  })
  assert.equal(edited.created, false)
  assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'model change')
  assert.equal(statSync(join(root, 'notes.txt')).mode & 0o777, 0o744)

  const after = await filesystem.readText(target, { maxBytes: 100 })
  await assert.rejects(filesystem.editText(target, '', 'x', {
    expectedVersion: after.version,
  }), /FS_AMBIGUOUS_EDIT/)
  await assert.rejects(filesystem.editText(target, 'missing', 'x', {
    expectedVersion: after.version,
  }), /FS_EDIT_NOT_FOUND/)
  writeFileSync(join(root, 'notes.txt'), 'same same')
  const duplicate = await filesystem.readText(target, { maxBytes: 100 })
  await assert.rejects(filesystem.editText(target, 'same', 'x', {
    expectedVersion: duplicate.version,
  }), /FS_AMBIGUOUS_EDIT/)
  assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'same same')

  const created = await filesystem.writeText(filesystem.resolve('new.txt'), 'new', {
    expectedVersion: null,
  })
  assert.equal(created.created, true)
  await assert.rejects(
    filesystem.writeText(filesystem.resolve('new.txt'), 'overwrite', { expectedVersion: null }),
    /FS_STALE_VERSION/,
  )
  assert.deepEqual(readdirSync(root).filter((name) => name.includes('.deepseek-cordis-')), [])
})

function request(
  toolName: string,
  argumentsValue: JsonValue,
  sessionId = 'session',
): SandboxRequest {
  return {
    sessionId,
    turnId: 'turn',
    callId: `${toolName}-call`,
    toolName,
    arguments: argumentsValue,
    risk: 'filesystem',
    profile: WORKSPACE_FILESYSTEM_PROFILE,
  }
}

test('sandbox enforces session observation before guarded write and edit', async (t) => {
  const root = temporaryDirectory(t)
  writeFileSync(join(root, 'existing.txt'), 'before')
  const sandbox = new WorkspaceFilesystemSandbox({
    filesystem: new NodeWorkspaceFileSystem({ root }),
    maxDirectoryEntries: 1,
  })

  const unobserved = await sandbox.prepare(request(WORKSPACE_WRITE_FILE_TOOL, {
    path: 'new.txt', content: 'new',
  }))
  assert.equal(unobserved.ok, false)
  assert.match(unobserved.ok ? '' : unobserved.reason, /FS_NOT_OBSERVED/)
  const missingStat = await sandbox.prepare(request(WORKSPACE_STAT_PATH_TOOL, { path: 'new.txt' }))
  assert.equal(missingStat.ok, true)
  if (!missingStat.ok) return
  assert.deepEqual(await missingStat.lease.execute(), { exists: false, path: 'new.txt' })

  const create = await sandbox.prepare(request(WORKSPACE_WRITE_FILE_TOOL, {
    path: 'new.txt', content: 'new',
  }))
  assert.equal(create.ok, true)
  if (!create.ok) return
  assert.equal((await create.lease.execute() as { created: boolean }).created, true)

  const metadata = await sandbox.prepare(request(WORKSPACE_STAT_PATH_TOOL, { path: 'existing.txt' }))
  assert.equal(metadata.ok, true)
  if (!metadata.ok) return
  await metadata.lease.execute()
  const editWithoutRead = await sandbox.prepare(request(WORKSPACE_EDIT_FILE_TOOL, {
    path: 'existing.txt', oldText: 'before', newText: 'after',
  }))
  assert.equal(editWithoutRead.ok, false)
  assert.match(editWithoutRead.ok ? '' : editWithoutRead.reason, /must be read before editing/)

  const read = await sandbox.prepare(request(WORKSPACE_READ_FILE_TOOL, { path: 'existing.txt' }))
  assert.equal(read.ok, true)
  if (!read.ok) return
  await read.lease.execute()
  const edit = await sandbox.prepare(request(WORKSPACE_EDIT_FILE_TOOL, {
    path: 'existing.txt', oldText: 'before', newText: 'after',
  }))
  assert.equal(edit.ok, true)
  if (!edit.ok) return
  await edit.lease.execute()
  assert.equal(readFileSync(join(root, 'existing.txt'), 'utf8'), 'after')

  const otherSession = await sandbox.prepare(request(WORKSPACE_WRITE_FILE_TOOL, {
    path: 'existing.txt', content: 'other',
  }, 'other'))
  assert.equal(otherSession.ok, false)
  assert.match(otherSession.ok ? '' : otherSession.reason, /FS_NOT_OBSERVED/)
})

test('registered tool family composes approval and retains create-tool compatibility', async (t) => {
  const root = temporaryDirectory(t)
  writeFileSync(join(root, 'b'), 'b')
  writeFileSync(join(root, 'a'), 'a')
  const sandbox = new WorkspaceFilesystemSandbox({
    filesystem: new NodeWorkspaceFileSystem({ root }), maxDirectoryEntries: 1,
  })
  const tools = new InMemoryToolRegistry()
  for (const definition of createWorkspaceFilesystemTools()) tools.register(definition)
  assert.deepEqual(tools.schemas().map(({ name }) => name), [
    WORKSPACE_READ_FILE_TOOL,
    WORKSPACE_LIST_DIRECTORY_TOOL,
    WORKSPACE_STAT_PATH_TOOL,
    WORKSPACE_WRITE_FILE_TOOL,
    WORKSPACE_EDIT_FILE_TOOL,
  ])
  const execution = await tools.execute(WORKSPACE_LIST_DIRECTORY_TOOL, { path: '.' }, {
    context: { sessionId: 'session', turnId: 'turn', callId: 'list' },
    approval: { request: async () => 'allowed-once' },
    sandbox,
    audit() {},
  })
  assert.deepEqual(execution, {
    ok: true,
    output: { path: '.', entries: [{ name: 'a', kind: 'file' }], truncated: true },
  })

  const legacy = await sandbox.prepare({
    ...request('create_workspace_file', { path: 'legacy.txt', content: 'compatible' }),
    profile: 'workspace-create-file',
  })
  assert.equal(legacy.ok, true)
  if (!legacy.ok) return
  assert.equal((await legacy.lease.execute() as { created: boolean }).created, true)
  assert.equal(readFileSync(join(root, 'legacy.txt'), 'utf8'), 'compatible')
})

test('sandbox validates profiles, arguments, limits, and lease disposal', async (t) => {
  const root = temporaryDirectory(t)
  const filesystem = new NodeWorkspaceFileSystem({ root })
  const sandbox = new WorkspaceFilesystemSandbox({ filesystem })
  assert.equal(sandbox.maxReadBytes, 1024 * 1024)
  assert.equal(sandbox.maxDirectoryEntries, 200)
  assert.throws(
    () => new WorkspaceFilesystemSandbox({ filesystem, maxReadBytes: 0 }),
    /positive integer/,
  )
  assert.throws(
    () => new WorkspaceFilesystemSandbox({ filesystem, maxDirectoryEntries: 0 }),
    /positive integer/,
  )

  assert.deepEqual(await sandbox.prepare({
    ...request(WORKSPACE_STAT_PATH_TOOL, { path: '.' }), profile: 'unsupported',
  }), { ok: false, reason: 'workspace filesystem does not support this operation' })
  assert.equal((await sandbox.prepare({
    ...request(WORKSPACE_STAT_PATH_TOOL, { path: '.' }), risk: 'shell',
  })).ok, false)
  const malformed: readonly JsonValue[] = [
    null,
    {},
    { path: '.', extra: true },
    { path: 1 },
  ]
  for (const argumentsValue of malformed) {
    const prepared = await sandbox.prepare(request(WORKSPACE_STAT_PATH_TOOL, argumentsValue))
    assert.equal(prepared.ok, false)
    assert.match(prepared.ok ? '' : prepared.reason, /FS_IO_ERROR/)
  }
  const unknown = await sandbox.prepare(request('unknown_workspace_operation', {}))
  assert.equal(unknown.ok, false)
  assert.match(unknown.ok ? '' : unknown.reason, /does not support this operation/)

  const prepared = await sandbox.prepare(request(WORKSPACE_LIST_DIRECTORY_TOOL, { path: '.' }))
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  prepared.lease.dispose()
  prepared.lease.dispose()
  await assert.rejects(prepared.lease.execute(), /lease is no longer executable/)
})

test('prepared versions detect races and cancellation prevents publication', async (t) => {
  const root = temporaryDirectory(t)
  writeFileSync(join(root, 'race.txt'), 'observed')
  const sandbox = new WorkspaceFilesystemSandbox({ filesystem: new NodeWorkspaceFileSystem({ root }) })
  const read = await sandbox.prepare(request(WORKSPACE_READ_FILE_TOOL, { path: 'race.txt' }))
  assert.equal(read.ok, true)
  if (!read.ok) return
  await read.lease.execute()
  const write = await sandbox.prepare(request(WORKSPACE_WRITE_FILE_TOOL, {
    path: 'race.txt', content: 'model',
  }))
  assert.equal(write.ok, true)
  if (!write.ok) return
  writeFileSync(join(root, 'race.txt'), 'host')
  await assert.rejects(write.lease.execute(), /FS_STALE_VERSION/)
  await assert.rejects(write.lease.execute(), /lease is no longer executable/)
  assert.equal(readFileSync(join(root, 'race.txt'), 'utf8'), 'host')

  const controller = new AbortController()
  const filesystem = new NodeWorkspaceFileSystem({ root })
  const target = filesystem.resolve('cancelled.txt')
  controller.abort('cancelled')
  await assert.rejects(
    filesystem.writeText(target, 'never', { expectedVersion: null, signal: controller.signal }),
    (error: unknown) => error instanceof FileSystemError && error.code === 'FS_ABORTED',
  )
  assert.equal(readdirSync(root).includes('cancelled.txt'), false)
})
