import assert from 'node:assert/strict'
import test from 'node:test'

import { InMemorySessionStore } from '@deepseek-cordis/session'

test('sessions append immutable sequenced events and expose a copied list', () => {
  const store = new InMemorySessionStore()
  const session = store.create('session-1')
  const call = { id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }

  session.append({ type: 'turn/start', turnId: 'turn-1' })
  session.append({ type: 'assistant/tool-calls', turnId: 'turn-1', calls: [call] })
  call.arguments.a = 100

  assert.deepEqual(session.events.map((event) => event.sequence), [1, 2])
  assert.deepEqual(session.events[1], {
    type: 'assistant/tool-calls',
    turnId: 'turn-1',
    calls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }],
    sequence: 2,
  })
  assert.equal(Object.isFrozen(session.events[1]), true)

  const exposed = session.events as unknown[]
  exposed.pop()
  assert.equal(session.events.length, 2)
})

test('projection includes model facts and excludes lifecycle bookkeeping', () => {
  const session = new InMemorySessionStore().create('projection')
  const turnId = 'projection:turn:1'
  session.append({ type: 'turn/start', turnId })
  session.append({ type: 'user/message', turnId, content: 'add 2 and 3' })
  session.append({ type: 'step/start', turnId, step: 1 })
  session.append({
    type: 'assistant/tool-calls',
    turnId,
    calls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }],
  })
  session.append({ type: 'tool/call', turnId, call: {
    id: 'call-1', name: 'add', arguments: { a: 2, b: 3 },
  } })
  session.append({
    type: 'tool/result', turnId, callId: 'call-1', name: 'add', ok: true, output: 5,
  })
  session.append({ type: 'step/end', turnId, step: 1, outcome: 'tool_calls' })
  session.append({
    type: 'tool/result', turnId, callId: 'call-2', name: 'missing', ok: false, error: 'missing',
  })
  session.append({ type: 'assistant/message', turnId, content: 'The answer is 5.' })
  session.append({ type: 'turn/end', turnId, status: 'completed' })

  assert.deepEqual(session.projectMessages(), [
    { role: 'user', content: 'add 2 and 3' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }],
    },
    { role: 'tool', callId: 'call-1', name: 'add', ok: true, output: 5 },
    { role: 'tool', callId: 'call-2', name: 'missing', ok: false, error: 'missing' },
    { role: 'assistant', content: 'The answer is 5.' },
  ])
})

test('stores reject duplicate IDs and return only owned sessions', () => {
  const store = new InMemorySessionStore()
  const session = store.create('stable-id')

  assert.equal(store.get('stable-id'), session)
  assert.equal(store.get('unknown'), undefined)
  assert.throws(() => store.create('stable-id'), /already exists/)
})
