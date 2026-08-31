import assert from 'node:assert/strict'
import test from 'node:test'

import { InMemorySessionStore } from '@deepseek-cordis/session'
import {
  estimateMessage,
  estimateTools,
  TokenMeter,
} from '@deepseek-cordis/token-meter'

test('measurements are immutable revisioned snapshots of surface and tools', () => {
  const session = new InMemorySessionStore().create('meter')
  session.append({ type: 'turn/start', turnId: 'turn-1' })
  session.append({ type: 'user/message', turnId: 'turn-1', content: 'abcdefgh' })
  session.append({ type: 'assistant/message', turnId: 'turn-1', content: 'answer' })
  session.append({ type: 'turn/end', turnId: 'turn-1', status: 'completed' })
  const tools = [{
    name: 'read', description: 'Read a value', inputSchema: { type: 'object' },
  }] as const
  const meter = new TokenMeter()

  const first = meter.measure(session, tools)
  session.append({ type: 'turn/start', turnId: 'turn-2' })
  session.append({ type: 'user/message', turnId: 'turn-2', content: 'later' })
  const second = meter.measure(session, tools)

  assert.equal(first.logRevision, 4)
  assert.deepEqual(first.nodes.map((node) => node.sequence), [2, 3])
  assert.equal(first.surfaceTokens,
    estimateMessage({ role: 'user', content: 'abcdefgh' })
    + estimateMessage({ role: 'assistant', content: 'answer' }))
  assert.equal(first.toolTokens, estimateTools(tools))
  assert.equal(first.totalTokens, first.surfaceTokens + first.toolTokens)
  assert.equal(first.source, 'heuristic')
  assert.equal(second.logRevision, 6)
  assert.ok(second.surfaceTokens > first.surfaceTokens)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.nodes), true)
  assert.equal(first.logRevision, 4)
})

test('provider input usage anchors later pressure while heuristic deltas stay live', () => {
  const session = new InMemorySessionStore().create('anchored-meter')
  const originalTools = [{
    name: 'read', description: 'Read', inputSchema: { type: 'object' },
  }] as const
  session.append({ type: 'turn/start', turnId: 'turn-1' })
  session.append({ type: 'user/message', turnId: 'turn-1', content: 'provider priced input' })
  session.append({
    type: 'assistant/message',
    turnId: 'turn-1',
    content: 'new assistant output',
    usage: {
      model: 'provider/model',
      inputTokens: 100,
      outputTokens: 7,
      inputSurfaceSequences: [2],
      inputTools: originalTools,
    },
  })

  const meter = new TokenMeter()
  const anchored = meter.measure(session, originalTools)
  assert.equal(anchored.source, 'provider_anchored')
  assert.deepEqual(anchored.anchor, {
    eventSequence: 3, model: 'provider/model', inputTokens: 100,
  })
  assert.equal(
    anchored.totalTokens,
    100 + estimateMessage({ role: 'assistant', content: 'new assistant output' }),
  )

  const expandedTools = [...originalTools, {
    name: 'write', description: 'Write', inputSchema: { type: 'object' },
  }] as const
  const expanded = meter.measure(session, expandedTools)
  assert.equal(
    expanded.totalTokens,
    anchored.totalTokens + estimateTools(expandedTools) - estimateTools(originalTools),
  )
  const otherRoute = meter.measure(session, expandedTools, { model: 'other/provider' })
  assert.equal(otherRoute.source, 'heuristic')
  assert.equal(otherRoute.anchor, undefined)
})

test('provider anchors survive provenance-preserving surface compaction', () => {
  const session = new InMemorySessionStore().create('anchored-compaction')
  session.append({ type: 'turn/start', turnId: 'turn-1' })
  session.append({ type: 'user/message', turnId: 'turn-1', content: 'old input' })
  session.append({
    type: 'assistant/message', turnId: 'turn-1', content: 'old output',
    usage: {
      model: 'provider/model', inputTokens: 100, outputTokens: 4,
      inputSurfaceSequences: [2], inputTools: [],
    },
  })
  session.append({ type: 'turn/end', turnId: 'turn-1', status: 'completed' })
  session.append({ type: 'turn/start', turnId: 'turn-2' })
  session.append({ type: 'user/message', turnId: 'turn-2', content: 'retained input' })
  session.append({ type: 'assistant/message', turnId: 'turn-2', content: 'retained output' })
  session.append({ type: 'turn/end', turnId: 'turn-2', status: 'completed' })
  session.append({
    type: 'compaction/summary', turnId: 'turn-1', summary: 'old checkpoint',
    shadowedSequences: [2, 3], summarizer: 'test/v1',
  })

  const measurement = new TokenMeter().measure(session)
  assert.equal(measurement.source, 'provider_anchored')
  assert.equal(measurement.anchor?.eventSequence, 3)
  assert.equal(measurement.totalTokens, 100
    + estimateMessage({ role: 'user', content: 'old checkpoint' })
    + estimateMessage({ role: 'user', content: 'retained input' })
    + estimateMessage({ role: 'assistant', content: 'retained output' })
    - estimateMessage({ role: 'user', content: 'old input' }))
})

test('message estimates include tool-call, result, and error payload framing', () => {
  const call = estimateMessage({
    role: 'assistant',
    toolCalls: [{ id: 'call-1', name: 'write', arguments: { value: 'payload' } }],
  })
  const result = estimateMessage({
    role: 'tool', callId: 'call-1', name: 'write', ok: true, output: { saved: true },
  })
  const failure = estimateMessage({
    role: 'tool', callId: 'call-1', name: 'write', ok: false, error: 'failed',
  })

  assert.ok(call > 8)
  assert.ok(result > 8)
  assert.ok(failure > 8)
})
