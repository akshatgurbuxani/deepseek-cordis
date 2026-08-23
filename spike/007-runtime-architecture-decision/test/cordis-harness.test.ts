import assert from 'node:assert/strict'
import test from 'node:test'

import { Context, FiberState, type Plugin } from 'cordis'

import {
  type JsonValue,
  ReplayModelAdapter,
  createAgentLoopPlugin,
  createModelPlugin,
  createSessionPlugin,
  createToolPlugin,
  createToolRegistryPlugin,
  mountPlugin,
  replaceWithRollback,
} from '../src/index.ts'

function addTool(offset = 0) {
  return createToolPlugin({
    name: 'add',
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

test('Cordis activates the loop after its providers and runs the Spike 006 turn', async () => {
  const context = new Context()
  const loopFactory = createAgentLoopPlugin()
  const loopFiber = context.plugin(loopFactory.plugin)
  assert.equal(loopFiber.state, FiberState.PENDING)

  const sessions = createSessionPlugin()
  const tools = createToolRegistryPlugin()
  const model = createModelPlugin(new ReplayModelAdapter('calculator', [
    {
      type: 'tool_calls',
      calls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }],
    },
    { type: 'message', content: 'The answer is 5.' },
  ]))

  await mountPlugin(context, sessions.plugin)
  await mountPlugin(context, tools.plugin)
  assert.equal(loopFiber.state, FiberState.PENDING)
  await mountPlugin(context, model.plugin)
  await loopFiber
  assert.equal(loopFiber.state, FiberState.ACTIVE)
  await mountPlugin(context, addTool())

  const session = context.sessions.create('calculator')
  const result = await context.agentLoop.run(session, 'add 2 and 3')

  assert.deepEqual(result, {
    turnId: 'calculator:turn:1',
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
})

test('effect-owned tools withdraw on disposal and replacements change execution', async () => {
  const context = new Context()
  await mountPlugin(context, createSessionPlugin().plugin)
  await mountPlugin(context, createToolRegistryPlugin().plugin)
  const adapter = new ReplayModelAdapter('tool-replacement', [
    {
      type: 'tool_calls',
      calls: [{ id: 'before', name: 'add', arguments: { a: 1, b: 1 } }],
    },
    { type: 'message', content: 'before replacement' },
    {
      type: 'tool_calls',
      calls: [{ id: 'after', name: 'add', arguments: { a: 1, b: 1 } }],
    },
    { type: 'message', content: 'after replacement' },
  ])
  await mountPlugin(context, createModelPlugin(adapter).plugin)
  await mountPlugin(context, createAgentLoopPlugin().plugin)

  const firstTool = await mountPlugin(context, addTool())
  const session = context.sessions.create('tool-replacement')
  await context.agentLoop.run(session, 'first')
  await firstTool.fiber.dispose()
  assert.deepEqual(context.tools.schemas(), [])

  await mountPlugin(context, addTool(10))
  await context.agentLoop.run(session, 'second')
  const results = session.events.filter((event) => event.type === 'tool/result')

  assert.deepEqual(results.map((event) => event.type === 'tool/result' && event.ok
    ? event.output
    : undefined), [2, 12])
})

test('model replacement reconnects one stable loop without replacing session history', async () => {
  const context = new Context()
  await mountPlugin(context, createSessionPlugin().plugin)
  await mountPlugin(context, createToolRegistryPlugin().plugin)
  const first = createModelPlugin(new ReplayModelAdapter('model-v1', [
    { type: 'message', content: 'from v1' },
  ]))
  let mountedModel = await mountPlugin(context, first.plugin)
  const loopFactory = createAgentLoopPlugin()
  await mountPlugin(context, loopFactory.plugin)

  const session = context.sessions.create('model-replacement')
  const loop = context.agentLoop
  await loop.run(session, 'first turn')

  const secondAdapter = new ReplayModelAdapter('model-v2', [
    { type: 'message', content: 'from v2' },
  ])
  const replacement = await replaceWithRollback(
    context,
    mountedModel,
    createModelPlugin(secondAdapter).plugin,
  )
  assert.equal(replacement.ok, true)
  mountedModel = replacement.current
  await loopFactory.value.run(session, 'second turn')

  assert.equal(context.agentLoop, loop)
  assert.equal(mountedModel.fiber.state, FiberState.ACTIVE)
  assert.deepEqual(secondAdapter.requests[0]?.messages, [
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'from v1' },
    { role: 'user', content: 'second turn' },
  ])
})

test('boot-level replacement restores the last working model after setup failure', async () => {
  const context = new Context()
  await mountPlugin(context, createSessionPlugin().plugin)
  await mountPlugin(context, createToolRegistryPlugin().plugin)
  const stableAdapter = new ReplayModelAdapter('stable', [
    { type: 'message', content: 'before failure' },
    { type: 'message', content: 'after recovery' },
  ])
  const stable = createModelPlugin(stableAdapter)
  const mountedModel = await mountPlugin(context, stable.plugin)
  const loop = createAgentLoopPlugin()
  await mountPlugin(context, loop.plugin)
  const session = context.sessions.create('rollback')
  await context.agentLoop.run(session, 'before')

  const broken = createModelPlugin(
    new ReplayModelAdapter('broken', []),
    'broken model setup',
  )
  const replacement = await replaceWithRollback(context, mountedModel, broken.plugin)

  assert.equal(replacement.ok, false)
  assert.match(replacement.error instanceof Error ? replacement.error.message : '', /broken model setup/)
  assert.equal(context.model, stableAdapter)
  assert.equal(context.agentLoop, loop.value)
  await context.agentLoop.run(session, 'after')
  assert.equal(session.events.at(-1)?.type, 'turn/end')
})

test('isolated contexts resolve different models while inheriting shared services', async () => {
  const root = new Context()
  const sessions = createSessionPlugin()
  const tools = createToolRegistryPlugin()
  await mountPlugin(root, sessions.plugin)
  await mountPlugin(root, tools.plugin)

  const first = root.isolate('model').isolate('agentLoop')
  const second = root.isolate('model').isolate('agentLoop')
  await mountPlugin(first, createModelPlugin(new ReplayModelAdapter('first', [
    { type: 'message', content: 'from first realm' },
  ])).plugin)
  await mountPlugin(second, createModelPlugin(new ReplayModelAdapter('second', [
    { type: 'message', content: 'from second realm' },
  ])).plugin)
  await mountPlugin(first, createAgentLoopPlugin().plugin)
  await mountPlugin(second, createAgentLoopPlugin().plugin)

  const firstSession = first.sessions.create('first-realm')
  const secondSession = second.sessions.create('second-realm')
  const [firstResult, secondResult] = await Promise.all([
    first.agentLoop.run(firstSession, 'which realm?'),
    second.agentLoop.run(secondSession, 'which realm?'),
  ])

  assert.equal(first.sessions, root.sessions)
  assert.equal(second.tools, root.tools)
  assert.equal(firstResult.content, 'from first realm')
  assert.equal(secondResult.content, 'from second realm')
})

test('nested Cordis effects dispose in reverse acquisition order exactly once', async () => {
  const context = new Context()
  const disposed: string[] = []
  const plugin: Plugin.Function<void> = (pluginContext) => {
    pluginContext.effect(function* () {
      yield () => disposed.push('first')
      yield () => disposed.push('second')
    })
  }

  const mounted = await mountPlugin(context, plugin)
  await mounted.fiber.dispose()
  await mounted.fiber.dispose()

  assert.deepEqual(disposed, ['second', 'first'])
})

test('disposing the loop withdraws its service and disconnects the stable facade', async () => {
  const context = new Context()
  await mountPlugin(context, createSessionPlugin().plugin)
  await mountPlugin(context, createToolRegistryPlugin().plugin)
  await mountPlugin(context, createModelPlugin(new ReplayModelAdapter('unused', [])).plugin)
  const loopFactory = createAgentLoopPlugin()
  const mountedLoop = await mountPlugin(context, loopFactory.plugin)
  const session = context.sessions.create('disposed-loop')

  await mountedLoop.fiber.dispose()

  assert.equal(context.get('agentLoop'), undefined)
  await assert.rejects(loopFactory.value.run(session, 'cannot run'), /not connected/)
})
