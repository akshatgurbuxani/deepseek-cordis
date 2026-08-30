import assert from 'node:assert/strict'
import test from 'node:test'

import {
  completeModel,
  ModelContextOverflowError,
  ModelStreamAbortedError,
  ModelStreamProtocolError,
  type ModelAdapter,
} from '@deepseek-cordis/model'
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

  assert.throws(
    () => new ReplayModelAdapter('invalid-capacity', [], { contextWindow: 0 }),
    /contextWindow must be a positive integer/,
  )
})

test('the shared collector exposes deltas and returns only the terminal response', async () => {
  const adapter: ModelAdapter = {
    id: 'chunked',
    async *stream() {
      yield { type: 'text-delta', delta: 'streamed ' }
      yield { type: 'text-delta', delta: 'answer' }
      yield {
        type: 'finish',
        reason: 'completed',
        response: { type: 'message', content: 'streamed answer' },
      }
    },
  }
  const deltas: string[] = []
  const response = await completeModel(adapter, {
    sessionId: 'stream', turnId: 'stream:turn:1', step: 1, messages: [], tools: [],
  }, { onTextDelta: (delta) => { deltas.push(delta) } })

  assert.deepEqual(deltas, ['streamed ', 'answer'])
  assert.deepEqual(response, { type: 'message', content: 'streamed answer' })
})

test('the shared collector rejects malformed and aborted streams', async () => {
  const request: ModelRequest = {
    sessionId: 'stream', turnId: 'stream:turn:1', step: 1, messages: [], tools: [],
  }
  const adapter = (stream: ModelAdapter['stream']): ModelAdapter => ({ id: 'invalid', stream })

  await assert.rejects(completeModel(adapter(async function* () {}), request),
    ModelStreamProtocolError)
  await assert.rejects(completeModel(adapter(async function* () {
    yield { type: 'text-delta', delta: 'partial' }
    yield {
      type: 'finish', reason: 'completed',
      response: { type: 'message', content: 'different' },
    }
  }), request), /deltas do not match/)
  await assert.rejects(completeModel(adapter(async function* () {
    yield { type: 'finish', reason: 'aborted' }
  }), request), ModelStreamAbortedError)
  await assert.rejects(completeModel(adapter(async function* () {
    yield {
      type: 'finish', reason: 'error', error: 'context too large',
      code: 'context_window_exceeded',
    }
  }), request), (error) => error instanceof ModelContextOverflowError
    && error.code === 'context_window_exceeded')
  await assert.rejects(completeModel(adapter(async function* () {
    yield {
      type: 'finish', reason: 'completed',
      response: { type: 'message', content: '' },
    }
    yield { type: 'text-delta', delta: 'late' }
  }), request), /after finish/)
})
