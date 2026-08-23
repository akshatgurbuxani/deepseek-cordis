import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DeclarativeHost,
  type JsonValue,
  type ManifestEntry,
  ReplayModelAdapter,
  StepLimitError,
  agentLoopPlugin,
  agentLoopService,
  modelPlugin,
  modelService,
  sessionPlugin,
  sessionsService,
  toolPlugin,
  toolRegistryPlugin,
  toolsService,
} from '../src/index.ts'

function entry(
  id: string,
  revision: string,
  load: ManifestEntry['load'],
): ManifestEntry {
  return { id, revision, load }
}

function addTool(name = 'add', offset = 0) {
  return toolPlugin({
    name,
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
    },
    execute(argumentsValue: JsonValue) {
      if (
        argumentsValue === null ||
        Array.isArray(argumentsValue) ||
        typeof argumentsValue !== 'object' ||
        typeof argumentsValue.a !== 'number' ||
        typeof argumentsValue.b !== 'number'
      ) throw new Error('invalid add arguments')
      return argumentsValue.a + argumentsValue.b + offset
    },
  })
}

function coreManifest(
  adapter: ReplayModelAdapter,
  tools: readonly ManifestEntry[] = [],
): ManifestEntry[] {
  return [
    entry('sessions', 'v1', () => sessionPlugin()),
    entry('tools', 'v1', () => toolRegistryPlugin()),
    ...tools,
    entry('model', adapter.id, () => modelPlugin(adapter)),
    entry('loop', 'v1', () => agentLoopPlugin()),
  ]
}

test('one tool-call turn is fully recorded and projected into the next request', async () => {
  const adapter = new ReplayModelAdapter('replay-v1', [
    {
      type: 'tool_calls',
      calls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }],
    },
    { type: 'message', content: 'The answer is 5.' },
  ])
  const host = new DeclarativeHost()
  await host.reconcile(coreManifest(adapter, [
    entry('add', 'v1', () => addTool()),
  ]))

  const session = host.runtime.get(sessionsService)!.create('session-1')
  const result = await host.runtime.get(agentLoopService)!.run(session, 'add 2 and 3')

  assert.deepEqual(result, {
    turnId: 'session-1:turn:1',
    content: 'The answer is 5.',
    steps: 2,
  })
  assert.deepEqual(session.events.map((event) => event.type), [
    'turn/start',
    'user/message',
    'step/start',
    'assistant/tool-calls',
    'tool/call',
    'tool/result',
    'step/end',
    'step/start',
    'assistant/message',
    'step/end',
    'turn/end',
  ])
  assert.deepEqual(session.events.map((event) => event.sequence),
    Array.from({ length: 11 }, (_, index) => index + 1))
  assert.deepEqual(adapter.requests[0]?.messages, [
    { role: 'user', content: 'add 2 and 3' },
  ])
  assert.deepEqual(adapter.requests[1]?.messages, [
    { role: 'user', content: 'add 2 and 3' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }],
    },
    {
      role: 'tool',
      callId: 'call-1',
      name: 'add',
      ok: true,
      output: 5,
    },
  ])
  assert.deepEqual(adapter.requests[0]?.tools.map((tool) => tool.name), ['add'])
  assert.deepEqual(adapter.requests[1]?.tools.map((tool) => tool.name), ['add'])
  assert.deepEqual(session.projectMessages(), adapter.requests[1]?.messages.concat([
    { role: 'assistant', content: 'The answer is 5.' },
  ]))
})

test('the same recorded scenario produces identical events and model requests', async () => {
  const run = async () => {
    const adapter = new ReplayModelAdapter('deterministic', [
      {
        type: 'tool_calls',
        calls: [{ id: 'same-call', name: 'add', arguments: { a: 4, b: 6 } }],
      },
      { type: 'message', content: '10' },
    ])
    const host = new DeclarativeHost()
    await host.reconcile(coreManifest(adapter, [entry('add', 'v1', () => addTool())]))
    const session = host.runtime.get(sessionsService)!.create('deterministic-session')
    await host.runtime.get(agentLoopService)!.run(session, 'calculate')
    return { events: session.events, requests: adapter.requests }
  }

  assert.deepEqual(await run(), await run())
})

test('tool schemas are read live again before every model step', async () => {
  const adapter = new ReplayModelAdapter('live-schemas', [
    {
      type: 'tool_calls',
      calls: [{ id: 'remove-call', name: 'remove_self', arguments: null }],
    },
    { type: 'message', content: 'the tool is gone' },
  ])
  const host = new DeclarativeHost()
  const withoutTool = coreManifest(adapter)
  const selfRemoving = entry('remove-self', 'v1', () => toolPlugin({
    name: 'remove_self',
    description: 'Remove this tool registration',
    inputSchema: {},
    async execute() {
      await host.reconcile(withoutTool)
      return 'removed'
    },
  }))
  await host.reconcile(coreManifest(adapter, [selfRemoving]))

  const session = host.runtime.get(sessionsService)!.create('live-schemas')
  await host.runtime.get(agentLoopService)!.run(session, 'remove the tool')

  assert.deepEqual(adapter.requests[0]?.tools.map((tool) => tool.name), ['remove_self'])
  assert.deepEqual(adapter.requests[1]?.tools, [])
  assert.equal(host.runtime.get(toolsService)!.size, 0)
})

test('tool replacement changes execution while preserving history and unrelated tools', async () => {
  const adapter = new ReplayModelAdapter('tool-reload-model', [
    {
      type: 'tool_calls',
      calls: [{ id: 'first', name: 'add', arguments: { a: 1, b: 1 } }],
    },
    { type: 'message', content: 'first complete' },
    {
      type: 'tool_calls',
      calls: [{ id: 'second', name: 'add', arguments: { a: 1, b: 1 } }],
    },
    { type: 'message', content: 'second complete' },
  ])
  const host = new DeclarativeHost()
  const echo = entry('echo', 'v1', () => toolPlugin({
    name: 'echo',
    description: 'Echo input',
    inputSchema: {},
    execute: (value) => value,
  }))
  const firstManifest = coreManifest(adapter, [
    entry('add', 'v1', () => addTool('add', 0)),
    echo,
  ])
  await host.reconcile(firstManifest)
  const session = host.runtime.get(sessionsService)!.create('tool-reload')
  const loop = host.runtime.get(agentLoopService)!
  await loop.run(session, 'first')
  const echoFiber = host.entry('echo')?.fiber
  const eventCount = session.events.length

  await host.reconcile(coreManifest(adapter, [
    entry('add', 'v2', () => addTool('add', 10)),
    echo,
  ]))
  await loop.run(session, 'second')

  const results = session.events.filter((event) => event.type === 'tool/result')
  assert.equal(results[0]?.type === 'tool/result' && results[0].ok
    ? results[0].output
    : undefined, 2)
  assert.equal(results[1]?.type === 'tool/result' && results[1].ok
    ? results[1].output
    : undefined, 12)
  assert.ok(session.events.length > eventCount)
  assert.equal(host.entry('echo')?.fiber, echoFiber)
  assert.deepEqual(host.runtime.get(toolsService)!.schemas().map((tool) => tool.name), [
    'echo',
    'add',
  ])
})

test('removing a tool withdraws its schema and logs missing and thrown results', async () => {
  const adapter = new ReplayModelAdapter('error-model', [
    {
      type: 'tool_calls',
      calls: [
        { id: 'missing', name: 'removed', arguments: null },
        { id: 'throwing', name: 'boom', arguments: null },
      ],
    },
    { type: 'message', content: 'I observed both errors.' },
  ])
  const host = new DeclarativeHost()
  const removed = entry('removed', 'v1', () => toolPlugin({
    name: 'removed',
    description: 'Will be removed',
    inputSchema: {},
    execute: () => 'old',
  }))
  const boom = entry('boom', 'v1', () => toolPlugin({
    name: 'boom',
    description: 'Throws',
    inputSchema: {},
    execute() { throw new Error('boom failed') },
  }))
  await host.reconcile(coreManifest(adapter, [removed, boom]))
  assert.equal(host.runtime.get(toolsService)!.size, 2)

  await host.reconcile(coreManifest(adapter, [boom]))
  const registry = host.runtime.get(toolsService)!
  assert.equal(registry.size, 1)
  assert.deepEqual(registry.schemas().map((tool) => tool.name), ['boom'])

  const session = host.runtime.get(sessionsService)!.create('tool-errors')
  await host.runtime.get(agentLoopService)!.run(session, 'try tools')
  const results = session.events.filter((event) => event.type === 'tool/result')

  assert.deepEqual(results.map((event) => event.type === 'tool/result' && !event.ok
    ? event.error
    : undefined), [
    'tool "removed" is not registered',
    'boom failed',
  ])
  assert.deepEqual(adapter.requests[1]?.messages.slice(-2), [
    {
      role: 'tool',
      callId: 'missing',
      name: 'removed',
      ok: false,
      error: 'tool "removed" is not registered',
    },
    {
      role: 'tool',
      callId: 'throwing',
      name: 'boom',
      ok: false,
      error: 'boom failed',
    },
  ])
})

test('model replacement affects the next turn without replacing session history', async () => {
  const first = new ReplayModelAdapter('model-v1', [
    { type: 'message', content: 'from v1' },
  ])
  const second = new ReplayModelAdapter('model-v2', [
    { type: 'message', content: 'from v2' },
  ])
  const host = new DeclarativeHost()
  await host.reconcile(coreManifest(first))
  const store = host.runtime.get(sessionsService)!
  const session = store.create('model-reload')
  const loop = host.runtime.get(agentLoopService)!
  await loop.run(session, 'first turn')
  const sessionFiber = host.entry('sessions')?.fiber

  await host.reconcile(coreManifest(second))
  assert.equal(host.runtime.get(agentLoopService), loop)
  assert.equal(host.runtime.get(sessionsService), store)
  assert.equal(host.entry('sessions')?.fiber, sessionFiber)
  await loop.run(session, 'second turn')

  assert.equal(first.requests.length, 1)
  assert.equal(second.requests.length, 1)
  assert.deepEqual(second.requests[0]?.messages, [
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'from v1' },
    { role: 'user', content: 'second turn' },
  ])
})

test('failed model reload restores the previous adapter and keeps the loop runnable', async () => {
  const stable = new ReplayModelAdapter('stable', [
    { type: 'message', content: 'before failure' },
    { type: 'message', content: 'after recovery' },
  ])
  const broken = new ReplayModelAdapter('broken', [])
  const host = new DeclarativeHost()
  const stableManifest = coreManifest(stable)
  await host.reconcile(stableManifest)
  const session = host.runtime.get(sessionsService)!.create('rollback')
  const loop = host.runtime.get(agentLoopService)!
  await loop.run(session, 'before')

  const brokenManifest = stableManifest.map((item): ManifestEntry =>
    item.id === 'model'
      ? entry('model', 'broken', () => ({
          ...modelPlugin(broken),
          setup() { throw new Error('broken model setup') },
        }))
      : item,
  )
  await assert.rejects(host.reconcile(brokenManifest), /broken model setup/)

  assert.equal(host.runtime.get(modelService), stable)
  assert.equal(host.runtime.get(agentLoopService), loop)
  await loop.run(session, 'after')
  assert.equal(stable.requests.length, 2)
  const recoveredLast = session.events.at(-1)
  assert.equal(recoveredLast?.type, 'turn/end')
  assert.equal(recoveredLast?.type === 'turn/end'
    ? recoveredLast.status
    : undefined, 'completed')
})

test('step limit records durable failure and releases the session run lock', async () => {
  const adapter = new ReplayModelAdapter('looping', [
    { type: 'tool_calls', calls: [{ id: 'one', name: 'missing', arguments: null }] },
    { type: 'tool_calls', calls: [{ id: 'two', name: 'missing', arguments: null }] },
    { type: 'message', content: 'recovered next turn' },
  ])
  const host = new DeclarativeHost()
  await host.reconcile(coreManifest(adapter))
  const session = host.runtime.get(sessionsService)!.create('bounded')
  const loop = host.runtime.get(agentLoopService)!

  await assert.rejects(
    loop.run(session, 'loop forever', { maxSteps: 2 }),
    StepLimitError,
  )
  assert.deepEqual(session.events.slice(-2).map((event) => event.type), [
    'turn/error',
    'turn/end',
  ])
  const failedLast = session.events.at(-1)
  assert.equal(failedLast?.type === 'turn/end'
    ? failedLast.status
    : undefined, 'failed')

  const result = await loop.run(session, 'new turn')
  assert.equal(result.content, 'recovered next turn')
  assert.equal(result.turnId, 'bounded:turn:2')
})
