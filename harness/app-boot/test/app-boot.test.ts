import assert from 'node:assert/strict'
import test from 'node:test'

import { AppBoot, type ManifestEntry } from '@deepseek-cordis/app-boot'
import { ReplayModelAdapter } from '@deepseek-cordis/model/testing'
import type { JsonValue } from '@deepseek-cordis/protocol'
import {
  createAgentLoopPlugin,
  createApprovalServicePlugin,
  createModelAdapterPlugin,
  createSandboxPlugin,
  createSessionStorePlugin,
  createSystemPromptPlugin,
  createToolRegistrationPlugin,
  createToolRegistryPlugin,
  RuntimeFiberState,
  type RuntimePlugin,
} from '@deepseek-cordis/runtime-cordis'

function entry(
  id: string,
  revision: string,
  plugin: RuntimePlugin,
  options: Pick<ManifestEntry, 'parentId' | 'enabled' | 'context'> = {},
): ManifestEntry {
  return { id, revision, load: () => plugin, ...options }
}

function addTool(offset = 0) {
  return createToolRegistrationPlugin({
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
    },
    safety: { risk: 'none' },
    execute(argumentsValue: JsonValue) {
      if (
        argumentsValue === null ||
        Array.isArray(argumentsValue) ||
        typeof argumentsValue !== 'object' ||
        typeof argumentsValue.a !== 'number' ||
        typeof argumentsValue.b !== 'number'
      )
        throw new Error('invalid add arguments')
      return argumentsValue.a + argumentsValue.b + offset
    },
  })
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap(errorMessages)]
  }
  return [error instanceof Error ? error.message : String(error)]
}

test('initial boot follows Cordis dependencies and an identical manifest is a no-op', async () => {
  const boot = new AppBoot()
  let loads = 0
  const sessions = createSessionStorePlugin()
  const tools = createToolRegistryPlugin()
  const model = createModelAdapterPlugin(
    new ReplayModelAdapter('calculator', [
      {
        type: 'tool_calls',
        calls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }],
      },
      { type: 'message', content: '5' },
    ]),
  )
  const loop = createAgentLoopPlugin()
  const plugins: Record<string, RuntimePlugin> = {
    loop: loop.plugin,
    sessions: sessions.plugin,
    tools: tools.plugin,
    model: model.plugin,
    approval: createApprovalServicePlugin().plugin,
    sandbox: createSandboxPlugin().plugin,
    prompt: createSystemPromptPlugin().plugin,
    add: addTool(),
  }
  const manifest = [
    'loop',
    'add',
    'sessions',
    'tools',
    'model',
    'approval',
    'sandbox',
    'prompt',
  ].map(
    (id): ManifestEntry => ({
      id,
      revision: 'v1',
      load() {
        loads += 1
        return plugins[id]!
      },
    }),
  )

  const first = await boot.reconcile(manifest)
  const loopFiber = boot.entry('loop')?.fiber
  const second = await boot.reconcile(manifest.map((item) => ({ ...item })))
  const result = await boot.context.agentLoop.run(
    boot.context.sessions.create('calculator'),
    'add 2 and 3',
  )

  const ids = ['add', 'approval', 'loop', 'model', 'prompt', 'sandbox', 'sessions', 'tools']
  assert.deepEqual([...first.added].sort(), ids)
  assert.deepEqual([...second.preserved].sort(), ids)
  assert.deepEqual(second.added, [])
  assert.deepEqual(second.updated, [])
  assert.equal(boot.entry('loop')?.fiber, loopFiber)
  assert.equal(loads, 8)
  assert.equal(result.content, '5')

  await boot.dispose()
})

test('tool replacement changes execution while preserving the loop and session history', async () => {
  const boot = new AppBoot()
  const sessions = createSessionStorePlugin()
  const tools = createToolRegistryPlugin()
  const adapter = new ReplayModelAdapter('tools', [
    {
      type: 'tool_calls',
      calls: [{ id: 'before', name: 'add', arguments: { a: 1, b: 1 } }],
    },
    { type: 'message', content: 'before' },
    {
      type: 'tool_calls',
      calls: [{ id: 'after', name: 'add', arguments: { a: 1, b: 1 } }],
    },
    { type: 'message', content: 'after' },
  ])
  const model = createModelAdapterPlugin(adapter)
  const loop = createAgentLoopPlugin()
  const base = [
    entry('sessions', 'v1', sessions.plugin),
    entry('tools', 'v1', tools.plugin),
    entry('model', 'v1', model.plugin),
    entry('approval', 'v1', createApprovalServicePlugin().plugin),
    entry('sandbox', 'v1', createSandboxPlugin().plugin),
    entry('prompt', 'v1', createSystemPromptPlugin().plugin),
    entry('loop', 'v1', loop.plugin),
  ]
  await boot.reconcile([...base, entry('add', 'v1', addTool())])
  const loopFiber = boot.entry('loop')?.fiber
  const session = boot.context.sessions.create('tool-replacement')
  await boot.context.agentLoop.run(session, 'first')

  const changed = await boot.reconcile([...base, entry('add', 'v2', addTool(10))])
  await boot.context.agentLoop.run(session, 'second')
  const results = session.events.filter((event) => event.type === 'tool/result')

  assert.deepEqual(changed.updated, ['add'])
  assert.equal(boot.entry('loop')?.fiber, loopFiber)
  assert.equal(boot.context.sessions, sessions.value)
  assert.deepEqual(
    results.map((event) => (event.ok ? event.output : undefined)),
    [2, 12],
  )

  await boot.dispose()
})

test('model replacement preserves history and a failed candidate restores the working graph', async () => {
  const boot = new AppBoot()
  const sessions = createSessionStorePlugin()
  const tools = createToolRegistryPlugin()
  const stableAdapter = new ReplayModelAdapter('stable', [
    { type: 'message', content: 'before failure' },
    { type: 'message', content: 'after recovery' },
  ])
  const stableModel = createModelAdapterPlugin(stableAdapter)
  const loop = createAgentLoopPlugin()
  const stableManifest = [
    entry('sessions', 'v1', sessions.plugin),
    entry('tools', 'v1', tools.plugin),
    entry('model', 'v1', stableModel.plugin),
    entry('approval', 'v1', createApprovalServicePlugin().plugin),
    entry('sandbox', 'v1', createSandboxPlugin().plugin),
    entry('prompt', 'v1', createSystemPromptPlugin().plugin),
    entry('loop', 'v1', loop.plugin),
  ]
  await boot.reconcile(stableManifest)
  const modelHandle = boot.entry('model')
  const loopFiber = boot.entry('loop')?.fiber
  const session = boot.context.sessions.create('rollback')
  await boot.context.agentLoop.run(session, 'before')

  const brokenModel: RuntimePlugin.Function<void> = (context) => {
    context.provide('model', new ReplayModelAdapter('broken', []))
    throw new Error('broken model activation')
  }
  Object.defineProperty(brokenModel, 'name', { configurable: true, value: 'model:broken' })
  brokenModel.provide = 'model'

  await assert.rejects(
    boot.reconcile(
      stableManifest.map((item) =>
        item.id === 'model' ? entry('model', 'v2', brokenModel) : item,
      ),
    ),
    /broken model activation/,
  )

  assert.equal(boot.entry('model'), modelHandle)
  assert.equal(modelHandle?.revision, 'v1')
  assert.equal(modelHandle?.fiber?.state, RuntimeFiberState.ACTIVE)
  assert.equal(boot.entry('loop')?.fiber, loopFiber)
  assert.equal(boot.context.model, stableAdapter)
  assert.equal((await boot.context.agentLoop.run(session, 'after')).content, 'after recovery')

  const nextAdapter = new ReplayModelAdapter('next', [
    { type: 'message', content: 'from next model' },
  ])
  const replacement = await boot.reconcile(
    stableManifest.map((item) =>
      item.id === 'model'
        ? entry('model', 'v3', createModelAdapterPlugin(nextAdapter).plugin)
        : item,
    ),
  )
  assert.deepEqual(replacement.updated, ['model'])
  assert.equal(boot.entry('model'), modelHandle)
  assert.equal(boot.entry('loop')?.fiber, loopFiber)
  assert.equal((await boot.context.agentLoop.run(session, 'next')).content, 'from next model')
  assert.deepEqual(nextAdapter.requests[0]?.messages, [
    { role: 'user', content: 'before' },
    { role: 'assistant', content: 'before failure' },
    { role: 'user', content: 'after' },
    { role: 'assistant', content: 'after recovery' },
    { role: 'user', content: 'next' },
  ])

  await boot.dispose()
})

test('module load failure leaves the exact running fibers untouched', async () => {
  const boot = new AppBoot()
  const sessions = createSessionStorePlugin()
  const stable = entry('sessions', 'v1', sessions.plugin)
  await boot.reconcile([stable])
  const handle = boot.entry('sessions')
  const fiber = handle?.fiber

  await assert.rejects(
    boot.reconcile([
      {
        id: 'sessions',
        revision: 'v2',
        load() {
          throw new SyntaxError('invalid module syntax')
        },
      },
    ]),
    /invalid module syntax/,
  )

  assert.equal(boot.entry('sessions'), handle)
  assert.equal(handle?.fiber, fiber)
  assert.equal(handle?.revision, 'v1')
  assert.equal(boot.context.sessions, sessions.value)

  await boot.dispose()
})

test('disabling a parent drains children first and preserves unrelated fibers', async () => {
  const boot = new AppBoot()
  const trace: string[] = []
  const traced = (id: string): RuntimePlugin.Function<void> => {
    const plugin: RuntimePlugin.Function<void> = (context) => {
      trace.push(`${id}:activate`)
      context.effect(() => () => {
        trace.push(`${id}:dispose`)
      })
    }
    Object.defineProperty(plugin, 'name', { configurable: true, value: id })
    return plugin
  }
  const initial = [
    entry('parent', 'v1', traced('parent')),
    entry('child', 'v1', traced('child'), { parentId: 'parent' }),
    entry('unrelated', 'v1', traced('unrelated')),
  ]
  await boot.reconcile(initial)
  const parentHandle = boot.entry('parent')
  const childHandle = boot.entry('child')
  const unrelatedFiber = boot.entry('unrelated')?.fiber

  const disabled = initial.map((item) =>
    item.id === 'parent' ? { ...item, enabled: false } : item,
  )
  const result = await boot.reconcile(disabled)

  assert.deepEqual(result.removed, ['child', 'parent'])
  assert.deepEqual(trace, [
    'parent:activate',
    'unrelated:activate',
    'child:activate',
    'child:dispose',
    'parent:dispose',
  ])
  assert.equal(boot.entry('parent'), parentHandle)
  assert.equal(boot.entry('child'), childHandle)
  assert.equal(boot.entry('unrelated')?.fiber, unrelatedFiber)

  await boot.reconcile(initial)
  assert.equal(parentHandle?.active, true)
  assert.equal(childHandle?.active, true)

  await boot.dispose()
  assert.deepEqual(boot.entries, [])
})

test('manifest validation rejects duplicates, missing parents, and cycles before loading', async () => {
  const boot = new AppBoot()
  let loads = 0
  const load = (): RuntimePlugin => {
    loads += 1
    return () => undefined
  }

  await assert.rejects(
    boot.reconcile([
      { id: 'same', revision: '1', load },
      { id: 'same', revision: '2', load },
    ]),
    /duplicate entry "same"/,
  )
  await assert.rejects(
    boot.reconcile([{ id: 'child', parentId: 'missing', revision: '1', load }]),
    /missing parent "missing"/,
  )
  await assert.rejects(
    boot.reconcile([
      { id: 'a', parentId: 'b', revision: '1', load },
      { id: 'b', parentId: 'a', revision: '1', load },
    ]),
    /parent cycle/,
  )

  assert.equal(loads, 0)
  assert.deepEqual(boot.entries, [])
  assert.equal(boot.entry('missing'), undefined)
})

test('queued manifests converge on the newest submitted revision', async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const boot = new AppBoot()
  const firstPlugin: RuntimePlugin.Function<void> = () => undefined
  const secondPlugin: RuntimePlugin.Function<void> = () => undefined

  const first = boot.reconcile([
    {
      id: 'version',
      revision: 'v1',
      async load() {
        await waiting
        return firstPlugin
      },
    },
  ])
  const second = boot.reconcile([entry('version', 'v2', secondPlugin)])

  release()
  await Promise.all([first, second])

  assert.equal(boot.entry('version')?.revision, 'v2')
  assert.equal(boot.entry('version')?.plugin, secondPlugin)

  await boot.dispose()
})

test('context changes remount an entry and rollback failure retains both errors', async () => {
  const boot = new AppBoot()
  let oldActivations = 0
  let failRestore = false
  const oldPlugin: RuntimePlugin.Function<void> = () => {
    oldActivations += 1
    if (failRestore) throw new Error('restoring old plugin failed')
  }
  const initial = entry('service', 'v1', oldPlugin)
  await boot.reconcile([initial])

  const otherContext = boot.context.extend()
  let contextLoads = 0
  const moved: ManifestEntry = {
    id: 'service',
    revision: 'v1',
    context: otherContext,
    load() {
      contextLoads += 1
      return () => undefined
    },
  }
  const movedResult = await boot.reconcile([moved])
  assert.deepEqual(movedResult.updated, ['service'])
  assert.equal(contextLoads, 1)

  await boot.reconcile([initial])
  assert.equal(oldActivations, 2)
  failRestore = true
  const broken: RuntimePlugin.Function<void> = () => {
    throw new Error('candidate activation failed')
  }
  const error = await boot.reconcile([entry('service', 'v2', broken)]).then(
    () => undefined,
    (reason: unknown) => reason,
  )

  assert.ok(error instanceof AggregateError)
  assert.ok(errorMessages(error).includes('candidate activation failed'))
  assert.ok(errorMessages(error).includes('restoring old plugin failed'))
  assert.equal(boot.entry('service')?.revision, 'v1')
  assert.equal(boot.entry('service')?.fiber?.state, RuntimeFiberState.FAILED)

  await boot.dispose()
})
