import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentLoop,
  StepLimitError,
  TOOL_CANCELLED_BEFORE_START,
  TOOL_CANCELLED_OUTCOME_UNKNOWN,
  TurnCancelledError,
} from '@deepseek-cordis/agent-loop'
import type { ApprovalService } from '@deepseek-cordis/approval'
import type { ModelAdapter } from '@deepseek-cordis/model'
import { ReplayModelAdapter } from '@deepseek-cordis/model/testing'
import type { JsonValue, ModelRequest, ModelResponse } from '@deepseek-cordis/protocol'
import { InMemorySession, InMemorySessionStore } from '@deepseek-cordis/session'
import type { ToolSandbox } from '@deepseek-cordis/sandbox'
import { InMemoryToolRegistry } from '@deepseek-cordis/tools'
import { InMemorySystemPrompt } from '@deepseek-cordis/system-prompt'

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
    safety: { risk: 'none' },
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

test('successful provider usage is anchored to the exact request surface', async () => {
  const adapter: ModelAdapter = {
    id: 'usage-model',
    async *stream() {
      yield { type: 'text-delta', delta: 'anchored' }
      yield {
        type: 'finish', reason: 'completed',
        response: { type: 'message', content: 'anchored' },
        usage: { inputTokens: 101, outputTokens: 3 },
      }
    },
  }
  const { sessions, loop } = setup(adapter)
  const session = sessions.create('usage')

  await loop.run(session, 'provider input')

  const assistant = session.events.find((event) => event.type === 'assistant/message')
  assert.ok(assistant?.type === 'assistant/message')
  assert.deepEqual(assistant.usage, {
    model: 'usage-model',
    inputTokens: 101,
    outputTokens: 3,
    inputSurfaceSequences: [2],
    inputTools: [],
  })
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
    safety: { risk: 'none' },
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
    safety: { risk: 'none' },
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

test('consequential calls durably audit approval and sandbox before execution', async () => {
  const adapter = new ReplayModelAdapter('safe-write', [
    {
      type: 'tool_calls',
      calls: [{ id: 'write-1', name: 'write-file', arguments: { path: 'note.txt' } }],
    },
    { type: 'message', content: 'written' },
  ])
  const sessions = new InMemorySessionStore()
  const tools = new InMemoryToolRegistry()
  tools.register({
    name: 'write-file',
    description: 'Write one workspace file',
    inputSchema: { type: 'object' },
    safety: {
      risk: 'filesystem',
      approvalReason: 'write note.txt in the workspace',
      sandbox: { profile: 'workspace-write', requiredEnforcement: 'full' },
    },
  })
  const order: string[] = []
  const approval: ApprovalService = {
    async request(request) {
      order.push('approval')
      assert.equal(request.callId, 'write-1')
      assert.equal(request.sessionId, 'safe-write-session')
      return 'allowed-once'
    },
  }
  const sandbox: ToolSandbox = {
    async prepare(request) {
      order.push('prepare')
      return {
        ok: true,
        lease: {
          provider: 'container/v1',
          enforcement: 'full',
          async execute() {
            order.push('execute')
            return { path: request.arguments }
          },
          dispose() {},
        },
      }
    },
  }
  const loop = new AgentLoop()
  loop.connect(sessions, tools, adapter, { approval, sandbox })
  const session = sessions.create('safe-write-session')

  await loop.run(session, 'write the note')

  assert.deepEqual(order, ['approval', 'prepare', 'execute'])
  assert.deepEqual(session.events.map((event) => event.type), [
    'turn/start', 'user/message', 'step/start', 'assistant/tool-calls', 'tool/call',
    'approval/asked', 'approval/decided', 'sandbox/prepared', 'tool/result',
    'step/end', 'step/start', 'assistant/message', 'step/end', 'turn/end',
  ])
  assert.deepEqual(adapter.requests[1]?.messages, [
    { role: 'user', content: 'write the note' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'write-1', name: 'write-file', arguments: { path: 'note.txt' } }],
    },
    {
      role: 'tool', callId: 'write-1', name: 'write-file', ok: true,
      output: { path: { path: 'note.txt' } },
    },
  ])
})

test('tool cancellation receives the turn signal and records a conservative result', async () => {
  const adapter = new ReplayModelAdapter('cancel-tool', [{
    type: 'tool_calls',
    calls: [
      { id: 'wait-1', name: 'wait', arguments: null },
      { id: 'later-1', name: 'later', arguments: null },
    ],
  }])
  const { sessions, tools, loop } = setup(adapter)
  let started: (() => void) | undefined
  const toolStarted = new Promise<void>((resolve) => { started = resolve })
  tools.register({
    name: 'wait',
    description: 'Wait until cancelled',
    inputSchema: {},
    safety: { risk: 'none' },
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
  const results = session.events.filter((event) => event.type === 'tool/result')
  assert.deepEqual(results, [
    {
      type: 'tool/result', turnId: 'cancel-tool:turn:1', callId: 'wait-1',
      name: 'wait', ok: false, error: TOOL_CANCELLED_OUTCOME_UNKNOWN, sequence: 6,
    },
    {
      type: 'tool/result', turnId: 'cancel-tool:turn:1', callId: 'later-1',
      name: 'later', ok: false, error: TOOL_CANCELLED_BEFORE_START, sequence: 7,
    },
  ])
  assert.deepEqual(session.events.slice(-4).map((event) => event.type), [
    'tool/result', 'tool/result', 'step/end', 'turn/end',
  ])
  assert.deepEqual(session.projectMessages().slice(-3), [
    {
      role: 'assistant',
      toolCalls: [
        { id: 'wait-1', name: 'wait', arguments: null },
        { id: 'later-1', name: 'later', arguments: null },
      ],
    },
    {
      role: 'tool', callId: 'wait-1', name: 'wait', ok: false,
      error: TOOL_CANCELLED_OUTCOME_UNKNOWN,
    },
    {
      role: 'tool', callId: 'later-1', name: 'later', ok: false,
      error: TOOL_CANCELLED_BEFORE_START,
    },
  ])
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

test('one coherent prompt assembly follows policy-discovered tools', async () => {
  const sessions = new InMemorySessionStore()
  const tools = new InMemoryToolRegistry()
  const model = new ReplayModelAdapter('prompted', [
    { type: 'message', content: 'prompt received' },
  ])
  const prompts = new InMemorySystemPrompt()
  let assemblies = 0
  prompts.register({
    name: 'dynamic-tools',
    order: 0,
    text: ({ sessionId, turnId, step, tools: visibleTools }) => {
      assemblies += 1
      return `${sessionId} ${turnId} step ${step}: ${visibleTools.map(({ name }) => name).join(',')}`
    },
  })
  const loop = new AgentLoop({
    async beforeStep(context) {
      tools.register({
        name: 'late-tool', description: 'Late tool', inputSchema: {},
        safety: { risk: 'none' }, execute: () => null,
      })
      assert.match(await context.readSystemPrompt() ?? '', /late-tool/)
    },
  })
  const disconnect = loop.connect(sessions, tools, model, { systemPrompt: prompts })
  const session = sessions.create('prompt-session')

  await loop.run(session, 'use your context')

  assert.equal(assemblies, 1)
  assert.equal(model.requests.length, 1)
  assert.equal(model.requests[0]?.systemPrompt,
    'prompt-session prompt-session:turn:1 step 1: late-tool')
  assert.deepEqual(model.requests[0]?.tools.map(({ name }) => name), ['late-tool'])
  disconnect()
})

test('provider usage records the exact system prompt sent with the request', async () => {
  const sessions = new InMemorySessionStore()
  const tools = new InMemoryToolRegistry()
  const prompts = new InMemorySystemPrompt()
  prompts.register({ name: 'persona', order: 0, text: 'Exact prompt.' })
  let captured: ModelRequest | undefined
  const model: ModelAdapter = {
    id: 'usage-with-prompt',
    async *stream(request) {
      captured = request
      yield {
        type: 'finish' as const,
        reason: 'completed' as const,
        response: { type: 'message' as const, content: 'done' },
        usage: { inputTokens: 12, outputTokens: 1 },
      }
    },
  }
  const loop = new AgentLoop()
  const disconnect = loop.connect(sessions, tools, model, { systemPrompt: prompts })
  const session = sessions.create('prompt-usage')

  await loop.run(session, 'start')

  assert.equal(captured?.systemPrompt, 'Exact prompt.')
  const response = session.events.find((event) => event.type === 'assistant/message')
  assert.equal(
    response?.type === 'assistant/message' ? response.usage?.inputSystemPrompt : undefined,
    'Exact prompt.',
  )
  disconnect()
})

test('cancellation during prompt assembly closes the turn before model work', async () => {
  const sessions = new InMemorySessionStore()
  const tools = new InMemoryToolRegistry()
  const model = new ReplayModelAdapter('unused-prompt-model', [])
  const prompts = new InMemorySystemPrompt()
  const controller = new AbortController()
  prompts.register({ name: 'cancel', order: 0, text: async () => {
    controller.abort({ kind: 'prompt-test' })
    return 'never sent'
  } })
  const loop = new AgentLoop()
  const disconnect = loop.connect(sessions, tools, model, { systemPrompt: prompts })
  const session = sessions.create('prompt-cancel')

  await assert.rejects(loop.run(session, 'start', { signal: controller.signal }), TurnCancelledError)

  assert.equal(model.requests.length, 0)
  assert.deepEqual(session.events.map(({ type }) => type), [
    'turn/start', 'user/message', 'turn/end',
  ])
  const terminal = session.events.at(-1)
  assert.equal(terminal?.type === 'turn/end' ? terminal.status : undefined, 'aborted')
  disconnect()
})
