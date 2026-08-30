import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  COMPACTION_INSTRUCTION,
  CompactionBusyError,
  CompactionChangedError,
  ModelSummaryAdapter,
  SessionCompactor,
  type SummaryAdapter,
  type SummaryRequest,
} from '@deepseek-cordis/compaction'
import { ReplayModelAdapter } from '@deepseek-cordis/model/testing'
import type { Session } from '@deepseek-cordis/session'
import { FileSessionStore } from '@deepseek-cordis/session-file'
import { InMemorySessionStore } from '@deepseek-cordis/session'

function appendTurn(session: Session, number: number, user: string, assistant: string): void {
  const turnId = `${session.id}:turn:${number}`
  session.append({ type: 'turn/start', turnId })
  session.append({ type: 'user/message', turnId, content: user })
  session.append({ type: 'step/start', turnId, step: 1 })
  session.append({ type: 'assistant/message', turnId, content: assistant })
  session.append({ type: 'step/end', turnId, step: 1, outcome: 'completed' })
  session.append({ type: 'turn/end', turnId, status: 'completed' })
}

class RecordingSummarizer implements SummaryAdapter {
  readonly id = 'recording/v1'
  readonly requests: SummaryRequest[] = []
  readonly #summaries: string[]

  constructor(summaries: string[]) {
    this.#summaries = [...summaries]
  }

  async summarize(request: SummaryRequest): Promise<string> {
    this.requests.push(request)
    const summary = this.#summaries.shift()
    if (summary === undefined) throw new Error('summary script exhausted')
    return summary
  }
}

test('compaction atomically shadows a closed-turn prefix with exact provenance', async () => {
  const session = new InMemorySessionStore().create('compact')
  appendTurn(session, 1, 'first user', 'first answer')
  appendTurn(session, 2, 'second user', 'second answer')
  appendTurn(session, 3, 'retained user', 'retained answer')
  const originalEvents = session.events
  const summarizer = new RecordingSummarizer(['checkpoint one'])

  const result = await new SessionCompactor(summarizer).compact(session)

  assert.ok(result)
  assert.deepEqual(result.shadowedSequences, [2, 4, 8, 10])
  assert.deepEqual(result.sourceMessages, [
    { role: 'user', content: 'first user' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second user' },
    { role: 'assistant', content: 'second answer' },
  ])
  assert.deepEqual(result.event, {
    type: 'compaction/summary',
    turnId: 'compact:turn:2',
    summary: 'checkpoint one',
    shadowedSequences: [2, 4, 8, 10],
    summarizer: 'recording/v1',
    sequence: 19,
  })
  assert.deepEqual(session.events.slice(0, originalEvents.length), originalEvents)
  assert.deepEqual(session.projectMessages(), [
    { role: 'user', content: 'checkpoint one' },
    { role: 'user', content: 'retained user' },
    { role: 'assistant', content: 'retained answer' },
  ])
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(summarizer.requests[0]?.messages), true)
})

test('later compaction chains provenance through the prior summary event', async () => {
  const session = new InMemorySessionStore().create('chain')
  appendTurn(session, 1, 'one', 'answer one')
  appendTurn(session, 2, 'two', 'answer two')
  appendTurn(session, 3, 'three', 'answer three')
  const summarizer = new RecordingSummarizer(['first checkpoint', 'second checkpoint'])
  const compactor = new SessionCompactor(summarizer)
  const first = await compactor.compact(session)
  assert.ok(first)
  appendTurn(session, 4, 'four', 'answer four')

  const second = await compactor.compact(session)

  assert.ok(second)
  assert.deepEqual(second.shadowedSequences, [first.event.sequence, 14, 16])
  assert.deepEqual(second.sourceMessages, [
    { role: 'user', content: 'first checkpoint' },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'answer three' },
  ])
  assert.deepEqual(session.projectMessages(), [
    { role: 'user', content: 'second checkpoint' },
    { role: 'user', content: 'four' },
    { role: 'assistant', content: 'answer four' },
  ])
})

test('whole-turn selection keeps assistant tool calls paired with their results', async () => {
  const session = new InMemorySessionStore().create('tool-pair')
  const turnId = 'tool-pair:turn:1'
  session.append({ type: 'turn/start', turnId })
  session.append({ type: 'user/message', turnId, content: 'read state' })
  session.append({ type: 'step/start', turnId, step: 1 })
  session.append({
    type: 'assistant/tool-calls', turnId,
    calls: [{ id: 'read-1', name: 'read', arguments: null }],
  })
  session.append({
    type: 'tool/call', turnId,
    call: { id: 'read-1', name: 'read', arguments: null },
  })
  session.append({
    type: 'tool/result', turnId, callId: 'read-1', name: 'read', ok: true, output: 'state',
  })
  session.append({ type: 'step/end', turnId, step: 1, outcome: 'tool_calls' })
  session.append({ type: 'step/start', turnId, step: 2 })
  session.append({ type: 'assistant/message', turnId, content: 'state read' })
  session.append({ type: 'step/end', turnId, step: 2, outcome: 'completed' })
  session.append({ type: 'turn/end', turnId, status: 'completed' })
  appendTurn(session, 2, 'retain me', 'retained')
  const summarizer = new RecordingSummarizer(['tool checkpoint'])

  const result = await new SessionCompactor(summarizer).compact(session)

  assert.ok(result)
  assert.deepEqual(result.shadowedSequences, [2, 4, 6, 9])
  assert.deepEqual(result.sourceMessages.slice(1, 3), [
    {
      role: 'assistant',
      toolCalls: [{ id: 'read-1', name: 'read', arguments: null }],
    },
    { role: 'tool', callId: 'read-1', name: 'read', ok: true, output: 'state' },
  ])
})

test('model summary adapter replays the selected prefix and requires a text response', async () => {
  const model = new ReplayModelAdapter('summary-model', [
    { type: 'message', content: 'model checkpoint' },
  ])
  const adapter = new ModelSummaryAdapter(model)
  const request: SummaryRequest = {
    sessionId: 'model-summary',
    messages: [{ role: 'user', content: 'source' }],
    sourceSequences: [2],
  }

  assert.equal(await adapter.summarize(request), 'model checkpoint')
  assert.equal(adapter.id, 'model:summary-model')
  assert.deepEqual(model.requests[0], {
    sessionId: 'model-summary',
    turnId: 'model-summary:compaction',
    step: 1,
    messages: [
      { role: 'user', content: 'source' },
      { role: 'user', content: COMPACTION_INSTRUCTION },
    ],
    tools: [],
  })

  const toolModel = new ReplayModelAdapter('bad-summary', [{
    type: 'tool_calls', calls: [{ id: 'call', name: 'noop', arguments: null }],
  }])
  await assert.rejects(
    new ModelSummaryAdapter(toolModel).summarize(request),
    /returned tool calls instead of a summary/,
  )
})

test('compaction refuses open, concurrent, changed, empty, and cancelled work', async () => {
  const session = new InMemorySessionStore().create('guards')
  appendTurn(session, 1, 'one', 'one')
  appendTurn(session, 2, 'two', 'two')
  let resolveSummary: ((summary: string) => void) | undefined
  const pending: SummaryAdapter = {
    id: 'pending',
    summarize: () => new Promise((resolve) => { resolveSummary = resolve }),
  }
  const compactor = new SessionCompactor(pending)
  const running = compactor.compact(session)
  await Promise.resolve()
  await assert.rejects(compactor.compact(session), CompactionBusyError)
  session.append({ type: 'turn/start', turnId: 'guards:turn:3' })
  resolveSummary?.('too late')
  await assert.rejects(running, CompactionChangedError)
  assert.equal(session.events.some((event) => event.type === 'compaction/summary'), false)
  await assert.rejects(compactor.compact(session), /has an open turn/)

  session.append({ type: 'turn/end', turnId: 'guards:turn:3', status: 'interrupted' })
  const empty = new SessionCompactor({ id: 'empty', summarize: async () => '  ' })
  await assert.rejects(empty.compact(session), /empty summary/)
  const controller = new AbortController()
  const reason = new Error('stop compaction')
  controller.abort(reason)
  await assert.rejects(empty.compact(session, { signal: controller.signal }), reason)
  await assert.rejects(empty.compact(session, { retainTurns: 0 }), RangeError)
  assert.throws(() => new SessionCompactor({ id: '', summarize: async () => 'x' }), /id/)

  const competing = new InMemorySessionStore().create('competing')
  appendTurn(competing, 1, 'one', 'one')
  appendTurn(competing, 2, 'two', 'two')
  appendTurn(competing, 3, 'three', 'three')
  let resolveCompeting: ((summary: string) => void) | undefined
  const slow = new SessionCompactor({
    id: 'slow',
    summarize: () => new Promise((resolve) => { resolveCompeting = resolve }),
  })
  const stale = slow.compact(competing)
  await Promise.resolve()
  await new SessionCompactor({ id: 'fast', summarize: async () => 'fast checkpoint' })
    .compact(competing)
  resolveCompeting?.('stale checkpoint')
  await assert.rejects(stale, /selected session history changed/)
  assert.equal(
    competing.events.filter((event) => event.type === 'compaction/summary').length,
    1,
  )

  const failingSession = new InMemorySessionStore().create('failing')
  appendTurn(failingSession, 1, 'one', 'one')
  appendTurn(failingSession, 2, 'two', 'two')
  let failures = 0
  const failing = new SessionCompactor({
    id: 'failure',
    summarize: async () => { failures += 1; throw new Error('summary unavailable') },
  })
  await assert.rejects(failing.compact(failingSession), /summary unavailable/)
  await assert.rejects(failing.compact(failingSession), /summary unavailable/)
  assert.equal(failures, 2)
})

test('file sessions persist the checkpoint and reconstruct the same surface after restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-compaction-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const store = new FileSessionStore({ directory })
  const session = store.create('durable-compaction')
  appendTurn(session, 1, 'old user', 'old answer')
  appendTurn(session, 2, 'new user', 'new answer')

  await new SessionCompactor(new RecordingSummarizer(['durable checkpoint'])).compact(session)
  const restarted = new FileSessionStore({ directory }).get(session.id)

  assert.ok(restarted)
  assert.deepEqual(restarted.events, session.events)
  assert.deepEqual(restarted.projectMessages(), [
    { role: 'user', content: 'durable checkpoint' },
    { role: 'user', content: 'new user' },
    { role: 'assistant', content: 'new answer' },
  ])
})

test('too little closed history is a no-op without invoking the summarizer', async () => {
  const session = new InMemorySessionStore().create('small')
  appendTurn(session, 1, 'only user', 'only answer')
  const summarizer = new RecordingSummarizer(['unused'])

  assert.equal(await new SessionCompactor(summarizer).compact(session), null)
  assert.deepEqual(summarizer.requests, [])
  assert.equal(session.events.length, 6)
})
