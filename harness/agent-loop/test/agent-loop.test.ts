import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentLoop, StepLimitError, TurnCancelledError } from '@deepseek-cordis/agent-loop'
import type { ModelAdapter } from '@deepseek-cordis/model'
import { ReplayModelAdapter } from '@deepseek-cordis/model/testing'
import type { JsonValue, ModelRequest, ModelResponse } from '@deepseek-cordis/protocol'
import { InMemorySession, InMemorySessionStore } from '@deepseek-cordis/session'
import { InMemoryToolRegistry } from '@deepseek-cordis/tools'

function addTool(registry: InMemoryToolRegistry, offset = 0): () => void {
  return registry.register({
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

function setup(model: ModelAdapter) {
  const sessions = new InMemorySessionStore()
  const tools = new InMemoryToolRegistry()
  const loop = new AgentLoop()
  const disconnect = loop.connect(sessions, tools, model)
  return { sessions, tools, loop, disconnect }
}

test('one tool-call turn is fully recorded and projected into the next request', async () => {
  const adapter = new ReplayModelAdapter('calculator', [
    {
      type: 'tool_calls',
      calls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }],
    },
    { type: 'message', content: 'The answer is 5.' },
  ])
  const { sessions, tools, loop } = setup(adapter)
  addTool(tools)
  const session = sessions.create('calculator')

  const result = await loop.run(session, 'add 2 and 3')

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
  assert.deepEqual(adapter.requests[1]?.messages, [
    { role: 'user', content: 'add 2 and 3' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }],
    },
    { role: 'tool', callId: 'call-1', name: 'add', ok: true, output: 5 },
  ])
  assert.deepEqual(session.projectMessages(), adapter.requests[1]?.messages.concat([
    { role: 'assistant', content: 'The answer is 5.' },
  ]))
})

test('the same scenario produces identical events and model requests', async () => {
  async function run() {
    const adapter = new ReplayModelAdapter('deterministic', [
      {
        type: 'tool_calls',
        calls: [{ id: 'same', name: 'add', arguments: { a: 4, b: 6 } }],
      },
      { type: 'message', content: '10' },
    ])
    const { sessions, tools, loop } = setup(adapter)
    addTool(tools)
    const session = sessions.create('deterministic')
    await loop.run(session, 'calculate')
    return { events: session.events, requests: adapter.requests }
  }

  assert.deepEqual(await run(), await run())
})

test('tool schemas are read live before every model step', async () => {
  const adapter = new ReplayModelAdapter('live-schemas', [
    {
      type: 'tool_calls',
      calls: [{ id: 'remove', name: 'remove_self', arguments: null }],
    },
    { type: 'message', content: 'the tool is gone' },
  ])
  const { sessions, tools, loop } = setup(adapter)
  let dispose = () => {}
  dispose = tools.register({
    name: 'remove_self',
    description: 'Remove this tool',
    inputSchema: {},
    execute() {
      dispose()
      return 'removed'
    },
  })

  await loop.run(sessions.create('live-schemas'), 'remove the tool')

  assert.deepEqual(adapter.requests[0]?.tools.map((tool) => tool.name), ['remove_self'])
  assert.deepEqual(adapter.requests[1]?.tools, [])
})

test('tool replacement changes later execution without replacing history', async () => {
  const adapter = new ReplayModelAdapter('tool-replacement', [
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
  const { sessions, tools, loop } = setup(adapter)
  const disposeFirst = addTool(tools)
  const session = sessions.create('tool-replacement')
  await loop.run(session, 'first')

  disposeFirst()
  addTool(tools, 10)
  await loop.run(session, 'second')

  const results = session.events.filter((event) => event.type === 'tool/result')
  assert.deepEqual(results.map((event) => event.type === 'tool/result' && event.ok
    ? event.output
    : undefined), [2, 12])
  assert.deepEqual(adapter.requests[2]?.messages.slice(0, 3), [
    { role: 'user', content: 'first' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'first', name: 'add', arguments: { a: 1, b: 1 } }],
    },
    { role: 'tool', callId: 'first', name: 'add', ok: true, output: 2 },
  ])
})

test('missing and throwing tool failures are recorded for the next model step', async () => {
  const adapter = new ReplayModelAdapter('tool-errors', [
    {
      type: 'tool_calls',
      calls: [
        { id: 'missing', name: 'missing', arguments: null },
        { id: 'throwing', name: 'boom', arguments: null },
      ],
    },
    { type: 'message', content: 'I observed both failures.' },
  ])
  const { sessions, tools, loop } = setup(adapter)
  tools.register({
    name: 'boom',
    description: 'Throw',
    inputSchema: {},
    execute() { throw new Error('boom failed') },
  })

  await loop.run(sessions.create('tool-errors'), 'try both')

  assert.deepEqual(adapter.requests[1]?.messages.slice(-2), [
    {
      role: 'tool', callId: 'missing', name: 'missing', ok: false,
      error: 'tool "missing" is not registered',
    },
    {
      role: 'tool', callId: 'throwing', name: 'boom', ok: false,
      error: 'boom failed',
    },
  ])
})

test('reconnecting the stable loop changes the model and preserves session history', async () => {
  const first = new ReplayModelAdapter('first', [
    { type: 'message', content: 'from first' },
  ])
  const { sessions, tools, loop, disconnect } = setup(first)
  const session = sessions.create('model-replacement')
  await loop.run(session, 'first turn')

  disconnect()
  const second = new ReplayModelAdapter('second', [
    { type: 'message', content: 'from second' },
  ])
  loop.connect(sessions, tools, second)
  await loop.run(session, 'second turn')

  assert.deepEqual(second.requests[0]?.messages, [
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'from first' },
    { role: 'user', content: 'second turn' },
  ])
})

test('model failure durably closes the turn and releases its run lock', async () => {
  const failing: ModelAdapter = {
    id: 'failing',
    async *stream() { throw 'model string failure' },
  }
  const { sessions, tools, loop, disconnect } = setup(failing)
  const session = sessions.create('model-failure')

  await assert.rejects(loop.run(session, 'fail'), (error) => error === 'model string failure')
  assert.deepEqual(session.events.slice(-3).map((event) => event.type), [
    'step/end', 'turn/error', 'turn/end',
  ])
  assert.deepEqual(session.events.at(-2), {
    type: 'turn/error',
    turnId: 'model-failure:turn:1',
    error: 'model string failure',
    sequence: 5,
  })

  disconnect()
  loop.connect(sessions, tools, new ReplayModelAdapter('recovered', [
    { type: 'message', content: 'recovered' },
  ]))
  assert.equal((await loop.run(session, 'retry')).content, 'recovered')
})

test('model Error objects record their message before escaping', async () => {
  const failing: ModelAdapter = {
    id: 'error-object',
    async *stream() { throw new Error('provider unavailable') },
  }
  const { sessions, loop } = setup(failing)
  const session = sessions.create('error-object')

  await assert.rejects(loop.run(session, 'fail'), /provider unavailable/)
  const turnError = session.events.find((event) => event.type === 'turn/error')
  assert.equal(turnError?.type === 'turn/error' ? turnError.error : undefined, 'provider unavailable')
})

test('the maximum-step guard records failure and permits a later turn', async () => {
  const adapter = new ReplayModelAdapter('bounded', [
    { type: 'tool_calls', calls: [{ id: 'one', name: 'missing', arguments: null }] },
    { type: 'tool_calls', calls: [{ id: 'two', name: 'missing', arguments: null }] },
    { type: 'message', content: 'later turn works' },
  ])
  const { sessions, loop } = setup(adapter)
  const session = sessions.create('bounded')

  await assert.rejects(loop.run(session, 'loop', { maxSteps: 2 }), StepLimitError)
  assert.deepEqual(session.events.slice(-2).map((event) => event.type), [
    'turn/error', 'turn/end',
  ])
  assert.equal((await loop.run(session, 'later')).content, 'later turn works')
})

test('connection and session guards reject invalid ownership and concurrent work', async () => {
  let release: ((response: ModelResponse) => void) | undefined
  let announceStart: (() => void) | undefined
  const started = new Promise<void>((resolve) => { announceStart = resolve })
  const blocking: ModelAdapter = {
    id: 'blocking',
    async *stream(_request: ModelRequest) {
      announceStart?.()
      const response = await new Promise<ModelResponse>((resolve) => { release = resolve })
      if (response.type === 'message') yield { type: 'text-delta' as const, delta: response.content }
      yield { type: 'finish' as const, reason: 'completed' as const, response }
    },
  }
  const { sessions, tools, loop, disconnect } = setup(blocking)
  assert.throws(() => loop.connect(sessions, tools, blocking), /already connected/)
  const session = sessions.create('concurrent')
  const running = loop.run(session, 'first')
  await started

  await assert.rejects(loop.run(session, 'second'), /already has a running turn/)
  assert.throws(disconnect, /while a turn is running/)
  release?.({ type: 'message', content: 'finished' })
  await running

  disconnect()
  disconnect()
  await assert.rejects(loop.run(session, 'disconnected'), /not connected/)

  const otherLoop = new AgentLoop()
  otherLoop.connect(sessions, tools, new ReplayModelAdapter('unused', []))
  await assert.rejects(
    otherLoop.run(new InMemorySession('foreign'), 'foreign'),
    /does not belong to this loop/,
  )
})

test('model-stream cancellation closes the durable turn without committing partial text', async () => {
  const streaming: ModelAdapter = {
    id: 'cancel-stream',
    async *stream(_request, options = {}) {
      yield { type: 'text-delta', delta: 'partial' }
      yield options.signal?.aborted
        ? { type: 'finish', reason: 'aborted' }
        : {
            type: 'finish', reason: 'completed',
            response: { type: 'message', content: 'partial' },
          }
    },
  }
  const { sessions, tools, loop, disconnect } = setup(streaming)
  const session = sessions.create('cancel-model')
  const controller = new AbortController()
  const deltas: string[] = []

  await assert.rejects(loop.run(session, 'cancel me', {
    signal: controller.signal,
    onTextDelta: (delta) => {
      deltas.push(delta)
      controller.abort({ kind: 'user' })
    },
  }), TurnCancelledError)

  assert.deepEqual(deltas, ['partial'])
  assert.equal(session.events.some((event) => event.type === 'assistant/message'), false)
  assert.equal(session.events.some((event) => event.type === 'turn/error'), false)
  assert.deepEqual(session.events.slice(-2), [
    {
      type: 'step/end', turnId: 'cancel-model:turn:1', step: 1,
      outcome: 'aborted', sequence: 4,
    },
    { type: 'turn/end', turnId: 'cancel-model:turn:1', status: 'aborted', sequence: 5 },
  ])

  disconnect()
  loop.connect(sessions, tools, new ReplayModelAdapter('after-cancel', [
    { type: 'message', content: 'next turn works' },
  ]))
  assert.equal((await loop.run(session, 'retry')).content, 'next turn works')
})

test('tool cancellation receives the turn signal and records no invented result', async () => {
  const adapter = new ReplayModelAdapter('cancel-tool', [{
    type: 'tool_calls',
    calls: [{ id: 'wait-1', name: 'wait', arguments: null }],
  }])
  const { sessions, tools, loop } = setup(adapter)
  let started: (() => void) | undefined
  const toolStarted = new Promise<void>((resolve) => { started = resolve })
  tools.register({
    name: 'wait',
    description: 'Wait until cancelled',
    inputSchema: {},
    async execute(_arguments, { signal }) {
      started?.()
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      })
      return null
    },
  })
  const session = sessions.create('cancel-tool')
  const controller = new AbortController()
  const running = loop.run(session, 'wait', { signal: controller.signal })
  await toolStarted
  controller.abort({ kind: 'user' })

  await assert.rejects(running, TurnCancelledError)
  assert.equal(session.events.some((event) => event.type === 'tool/result'), false)
  assert.deepEqual(session.events.slice(-2).map((event) => event.type), ['step/end', 'turn/end'])
  const terminal = session.events.at(-1)
  assert.equal(terminal?.type === 'turn/end' ? terminal.status : undefined, 'aborted')
})

test('invalid step limits fail before recording a turn', async () => {
  const { sessions, loop } = setup(new ReplayModelAdapter('unused', []))
  const session = sessions.create('invalid-limit')

  await assert.rejects(loop.run(session, 'zero', { maxSteps: 0 }), RangeError)
  await assert.rejects(loop.run(session, 'fraction', { maxSteps: 1.5 }), RangeError)
  assert.deepEqual(session.events, [])

  const controller = new AbortController()
  controller.abort({ kind: 'user' })
  await assert.rejects(loop.run(session, 'cancelled', { signal: controller.signal }),
    TurnCancelledError)
  assert.deepEqual(session.events, [])
})
