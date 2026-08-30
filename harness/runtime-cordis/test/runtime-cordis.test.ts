import assert from 'node:assert/strict'
import test from 'node:test'

import { ReplayModelAdapter } from '@deepseek-cordis/model/testing'
import { SessionCompactor } from '@deepseek-cordis/compaction'
import type { JsonValue } from '@deepseek-cordis/protocol'
import { InMemoryToolRegistry, type ToolDefinition } from '@deepseek-cordis/tools'
import {
  createAgentLoopPlugin,
  createCompactionPlugin,
  createModelAdapterPlugin,
  createSessionStorePlugin,
  createToolRegistrationPlugin,
  createToolRegistryPlugin,
  createTokenMeterPlugin,
} from '@deepseek-cordis/runtime-cordis'
import { Context, FiberState, type Fiber, type Plugin } from 'cordis'

async function mount(context: Context, plugin: Plugin): Promise<Fiber> {
  const fiber = context.plugin(plugin)
  await fiber
  return fiber
}

async function disposeReverse(fibers: readonly Fiber[]): Promise<void> {
  for (const fiber of fibers.toReversed()) await fiber.dispose()
}

function addTool(offset = 0): ToolDefinition {
  return {
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
        argumentsValue === null
        || Array.isArray(argumentsValue)
        || typeof argumentsValue !== 'object'
        || typeof argumentsValue.a !== 'number'
        || typeof argumentsValue.b !== 'number'
      ) throw new Error('invalid add arguments')
      return argumentsValue.a + argumentsValue.b + offset
    },
  }
}

test('the loop remains pending until every provider exists, then runs a complete turn', async () => {
  const context = new Context()
  const loopFactory = createAgentLoopPlugin()
  const loopFiber = context.plugin(loopFactory.plugin)
  assert.equal(loopFiber.state, FiberState.PENDING)

  const sessions = createSessionStorePlugin()
  const tools = createToolRegistryPlugin()
  const model = createModelAdapterPlugin(new ReplayModelAdapter('calculator', [
    {
      type: 'tool_calls',
      calls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }],
    },
    { type: 'message', content: 'The answer is 5.' },
  ]))
  const fibers = [
    loopFiber,
    await mount(context, sessions.plugin),
    await mount(context, tools.plugin),
  ]
  assert.equal(loopFiber.state, FiberState.PENDING)

  fibers.push(await mount(context, model.plugin))
  await loopFiber
  assert.equal(loopFiber.state, FiberState.ACTIVE)
  fibers.push(await mount(context, createToolRegistrationPlugin(addTool())))

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

  await disposeReverse(fibers)
})

test('effect-owned tool registration withdraws once and replacement changes later execution', async () => {
  class CountingRegistry extends InMemoryToolRegistry {
    disposeCount = 0

    override register(definition: ToolDefinition): () => void {
      const dispose = super.register(definition)
      return () => {
        this.disposeCount += 1
        dispose()
      }
    }
  }

  const context = new Context()
  const registry = new CountingRegistry()
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
  const fibers = [
    await mount(context, createSessionStorePlugin().plugin),
    await mount(context, createToolRegistryPlugin(registry).plugin),
    await mount(context, createModelAdapterPlugin(adapter).plugin),
    await mount(context, createAgentLoopPlugin().plugin),
  ]

  const firstTool = await mount(context, createToolRegistrationPlugin(addTool()))
  const session = context.sessions.create('tool-replacement')
  await context.agentLoop.run(session, 'first')
  await firstTool.dispose()
  await firstTool.dispose()
  assert.equal(registry.disposeCount, 1)
  assert.deepEqual(registry.schemas(), [])

  const secondTool = await mount(context, createToolRegistrationPlugin(addTool(10)))
  fibers.push(secondTool)
  await context.agentLoop.run(session, 'second')
  const results = session.events.filter((event) => event.type === 'tool/result')
  assert.deepEqual(results.map((event) => event.ok ? event.output : undefined), [2, 12])

  await disposeReverse(fibers)
  assert.equal(registry.disposeCount, 2)
})

test('model withdrawal drains and reconnects the same loop without replacing sessions', async () => {
  const context = new Context()
  const sessions = createSessionStorePlugin()
  const tools = createToolRegistryPlugin()
  const firstModel = createModelAdapterPlugin(new ReplayModelAdapter('model-v1', [
    { type: 'message', content: 'from v1' },
  ]))
  const loop = createAgentLoopPlugin()
  const sessionFiber = await mount(context, sessions.plugin)
  const toolsFiber = await mount(context, tools.plugin)
  const firstModelFiber = await mount(context, firstModel.plugin)
  const loopFiber = await mount(context, loop.plugin)
  const session = context.sessions.create('model-replacement')
  const stableLoop = context.agentLoop
  await stableLoop.run(session, 'first turn')

  await firstModelFiber.dispose()
  assert.equal(context.get('agentLoop'), undefined)
  await assert.rejects(loop.value.run(session, 'while disconnected'), /not connected/)

  const secondAdapter = new ReplayModelAdapter('model-v2', [
    { type: 'message', content: 'from v2' },
  ])
  const secondModelFiber = await mount(
    context,
    createModelAdapterPlugin(secondAdapter).plugin,
  )
  await loopFiber
  const result = await loop.value.run(session, 'second turn')

  assert.equal(context.agentLoop, stableLoop)
  assert.equal(context.sessions, sessions.value)
  assert.equal(result.content, 'from v2')
  assert.deepEqual(secondAdapter.requests[0]?.messages, [
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'from v1' },
    { role: 'user', content: 'second turn' },
  ])

  await disposeReverse([sessionFiber, toolsFiber, secondModelFiber, loopFiber])
})

test('isolated contexts inherit sessions and tools but resolve independent models and loops', async () => {
  const root = new Context()
  const sessions = createSessionStorePlugin()
  const tools = createToolRegistryPlugin()
  const rootFibers = [
    await mount(root, sessions.plugin),
    await mount(root, tools.plugin),
  ]
  const first = root.isolate('model').isolate('agentLoop')
  const second = root.isolate('model').isolate('agentLoop')
  const realmFibers = [
    await mount(first, createModelAdapterPlugin(new ReplayModelAdapter('first', [
      { type: 'message', content: 'from first realm' },
    ])).plugin),
    await mount(second, createModelAdapterPlugin(new ReplayModelAdapter('second', [
      { type: 'message', content: 'from second realm' },
    ])).plugin),
    await mount(first, createAgentLoopPlugin().plugin),
    await mount(second, createAgentLoopPlugin().plugin),
  ]

  const [firstResult, secondResult] = await Promise.all([
    first.agentLoop.run(first.sessions.create('first-realm'), 'which realm?'),
    second.agentLoop.run(second.sessions.create('second-realm'), 'which realm?'),
  ])

  assert.equal(first.sessions, root.sessions)
  assert.equal(second.tools, root.tools)
  assert.notEqual(first.agentLoop, second.agentLoop)
  assert.equal(firstResult.content, 'from first realm')
  assert.equal(secondResult.content, 'from second realm')

  await disposeReverse(realmFibers)
  await disposeReverse(rootFibers)
})

test('Cordis effects recover in reverse acquisition order exactly once', async () => {
  const context = new Context()
  const recovered: string[] = []
  const plugin: Plugin.Function<void> = (pluginContext) => {
    pluginContext.effect(function* () {
      yield () => recovered.push('first')
      yield () => recovered.push('second')
    })
  }
  Object.defineProperty(plugin, 'name', { configurable: true, value: 'nested-effects' })

  const fiber = await mount(context, plugin)
  await fiber.dispose()
  await fiber.dispose()

  assert.deepEqual(recovered, ['second', 'first'])
})

test('activation failures reject their fiber without disturbing an active registration', async () => {
  const context = new Context()
  const registryFiber = await mount(context, createToolRegistryPlugin().plugin)
  const firstTool = await mount(context, createToolRegistrationPlugin(addTool()))
  const duplicate = context.plugin(createToolRegistrationPlugin(addTool(1)))

  await assert.rejects(async () => await duplicate, /already registered/)
  assert.equal(duplicate.state, FiberState.FAILED)
  assert.equal(context.tools.size, 1)
  assert.equal((await context.tools.execute('add', { a: 1, b: 2 })).ok, true)

  await duplicate.dispose()
  await firstTool.dispose()
  await registryFiber.dispose()
})

test('disposing all mounted fibers withdraws services, registrations, and connections', async () => {
  const context = new Context()
  const sessions = createSessionStorePlugin()
  const tools = createToolRegistryPlugin()
  const model = createModelAdapterPlugin(new ReplayModelAdapter('cleanup', []))
  const loop = createAgentLoopPlugin()
  const fibers = [
    await mount(context, sessions.plugin),
    await mount(context, tools.plugin),
    await mount(context, model.plugin),
    await mount(context, loop.plugin),
    await mount(context, createToolRegistrationPlugin(addTool())),
  ]
  const session = sessions.value.create('after-cleanup')

  await disposeReverse(fibers)

  assert.equal(tools.value.size, 0)
  assert.equal(context.get('sessions'), undefined)
  assert.equal(context.get('tools'), undefined)
  assert.equal(context.get('model'), undefined)
  assert.equal(context.get('agentLoop'), undefined)
  await assert.rejects(loop.value.run(session, 'cannot run'), /not connected/)
  assert.ok(fibers.every((fiber) => fiber.state === FiberState.DISPOSED))
})

test('compaction is an optional Cordis capability with stable provider identity', async () => {
  const context = new Context()
  const compactor = new SessionCompactor({
    id: 'runtime-test',
    summarize: async () => 'checkpoint',
  })
  const factory = createCompactionPlugin(compactor)

  assert.equal(context.get('compaction'), undefined)
  const fiber = await mount(context, factory.plugin)
  assert.equal(context.compaction, compactor)
  assert.equal(factory.value, compactor)

  await fiber.dispose()
  assert.equal(context.get('compaction'), undefined)
})

test('token measurement is an independently withdrawable Cordis capability', async () => {
  const context = new Context()
  const factory = createTokenMeterPlugin()
  const fiber = await mount(context, factory.plugin)

  assert.equal(context.tokenMeter, factory.value)
  await fiber.dispose()
  assert.equal(context.get('tokenMeter'), undefined)
})
