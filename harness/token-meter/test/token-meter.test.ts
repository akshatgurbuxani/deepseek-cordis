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
  assert.equal(second.logRevision, 6)
  assert.ok(second.surfaceTokens > first.surfaceTokens)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.nodes), true)
  assert.equal(first.logRevision, 4)
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
