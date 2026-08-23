import assert from 'node:assert/strict'
import test from 'node:test'

import { ReplayModelAdapter } from '@deepseek-cordis/model/testing'
import type { ModelRequest, ModelResponse } from '@deepseek-cordis/protocol'

test('replay adapters snapshot scripts, requests, and returned responses', async () => {
  const scripted: ModelResponse = { type: 'message', content: 'original' }
  const adapter = new ReplayModelAdapter('replay', [scripted])
  const request: ModelRequest = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    step: 1,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  }

  ;(scripted as { content: string }).content = 'mutated script'
  const response = await adapter.complete(request)
  ;(request.messages[0] as { content: string }).content = 'mutated request'

  assert.deepEqual(response, { type: 'message', content: 'original' })
  assert.deepEqual(adapter.requests[0]?.messages, [{ role: 'user', content: 'hello' }])
  assert.equal(Object.isFrozen(response), true)
  assert.equal(Object.isFrozen(adapter.requests[0]), true)
})

test('replay adapters fail explicitly when the script is exhausted', async () => {
  const adapter = new ReplayModelAdapter('empty', [])
  await assert.rejects(adapter.complete({
    sessionId: 'session-1',
    turnId: 'turn-1',
    step: 1,
    messages: [],
    tools: [],
  }), /replay adapter "empty" exhausted/)
})
