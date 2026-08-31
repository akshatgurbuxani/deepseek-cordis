import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentLoop, TurnCancelledError } from '@deepseek-cordis/agent-loop'
import { ModelSummaryAdapter, SessionCompactor } from '@deepseek-cordis/compaction'
import { ContextBudgetPolicy } from '@deepseek-cordis/context-budget'
import type { ModelAdapter } from '@deepseek-cordis/model'
import { ModelContextOverflowError } from '@deepseek-cordis/model'
import { ReplayModelAdapter } from '@deepseek-cordis/model/testing'
import type { ModelStreamChunk } from '@deepseek-cordis/protocol'
import { InMemorySessionStore, type Session } from '@deepseek-cordis/session'
import { InMemoryToolRegistry } from '@deepseek-cordis/tools'

function appendTurn(session: Session, number: number, content = `history ${number}`): void {
  const turnId = `${session.id}:turn:${number}`
  session.append({ type: 'turn/start', turnId })
  session.append({ type: 'user/message', turnId, content })
  session.append({ type: 'step/start', turnId, step: 1 })
  session.append({ type: 'assistant/message', turnId, content: `answer ${number}` })
  session.append({ type: 'step/end', turnId, step: 1, outcome: 'completed' })
  session.append({ type: 'turn/end', turnId, status: 'completed' })
}

function replayWithCapacity(
  responses: ConstructorParameters<typeof ReplayModelAdapter>[1],
  contextWindow?: number,
): ModelAdapter & { readonly requests: ReplayModelAdapter['requests'] } {
  const replay = new ReplayModelAdapter('budget-model', responses)
  return {
    id: replay.id,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    requests: replay.requests,
    stream: replay.stream.bind(replay),
  }
}

function policy(summary = 'history checkpoint'): ContextBudgetPolicy {
  const summaryModel = new ReplayModelAdapter('summary', [{ type: 'message', content: summary }])
  return new ContextBudgetPolicy({
    compactor: new SessionCompactor(new ModelSummaryAdapter(summaryModel)),
  })
}

test('pressure compacts before request derivation and records the exact decision', async () => {
  const sessions = new InMemorySessionStore()
  const session = sessions.create('pressure')
  appendTurn(session, 1, 'a'.repeat(80))
  appendTurn(session, 2, 'retained')
  const model = replayWithCapacity([{ type: 'message', content: 'done' }], 40)
  const loop = new AgentLoop(policy())
  const disconnect = loop.connect(sessions, new InMemoryToolRegistry(), model)

  const result = await loop.run(session, 'current')

  assert.equal(result.content, 'done')
  assert.deepEqual(model.requests[0]?.messages.slice(0, 2), [
    { role: 'user', content: 'history checkpoint' },
    { role: 'user', content: 'retained' },
  ])
  const decision = session.events.find((event) => event.type === 'context-budget/decision')
  assert.ok(decision?.type === 'context-budget/decision')
  assert.equal(decision.trigger, 'pressure')
  assert.equal(decision.outcome, 'compacted')
  assert.equal(decision.contextWindow, 40)
  assert.equal(decision.thresholdTokens, 32)
  assert.equal(typeof decision.summarySequence, 'number')
  disconnect()
})

test('pressure uses asynchronously resolved adapter capacity', async () => {
  const sessions = new InMemorySessionStore()
  const session = sessions.create('resolved-pressure')
  appendTurn(session, 1, 'a'.repeat(80))
  appendTurn(session, 2)
  const replay = new ReplayModelAdapter('resolved-model', [{ type: 'message', content: 'done' }])
  const tools = new InMemoryToolRegistry()
  let resolutions = 0
  const model: ModelAdapter = {
    id: replay.id,
    async resolveInfo() {
      resolutions += 1
      tools.register({
        name: 'late-tool',
        description: 'x'.repeat(800),
        inputSchema: { type: 'object' },
        safety: { risk: 'none' },
        execute: () => null,
      })
      return { model: 'provider/resolved-model', contextWindow: 40 }
    },
    stream: replay.stream.bind(replay),
  }
  const loop = new AgentLoop(policy())
  const disconnect = loop.connect(sessions, tools, model)

  await loop.run(session, 'current')

  assert.equal(resolutions, 1)
  const decision = session.events.find((event) => event.type === 'context-budget/decision')
  assert.ok(decision?.type === 'context-budget/decision')
  assert.equal(decision.contextWindow, 40)
  assert.equal(decision.outcome, 'compacted')
  assert.ok(decision.measuredTokens > 200)
  disconnect()
})

test('metadata lookup failure disables proactive policy without blocking the model', async () => {
  const sessions = new InMemorySessionStore()
  const session = sessions.create('metadata-unavailable')
  const replay = new ReplayModelAdapter('available-model', [
    { type: 'message', content: 'still runs' },
  ])
  const model: ModelAdapter = {
    id: replay.id,
    async resolveInfo() {
      throw new Error('catalog unavailable')
    },
    stream: replay.stream.bind(replay),
  }
  const loop = new AgentLoop(policy())
  const disconnect = loop.connect(sessions, new InMemoryToolRegistry(), model)

  assert.equal((await loop.run(session, 'current')).content, 'still runs')
  assert.equal(
    session.events.some((event) => event.type === 'context-budget/decision'),
    false,
  )
  disconnect()
})

test('canonical overflow retries only after a checkpoint changes the surface', async () => {
  const sessions = new InMemorySessionStore()
  const session = sessions.create('overflow')
  appendTurn(session, 1)
  appendTurn(session, 2)
  let calls = 0
  const requests: unknown[] = []
  const model: ModelAdapter = {
    id: 'overflow-model',
    async *stream(request): AsyncIterable<ModelStreamChunk> {
      requests.push(request)
      calls += 1
      if (calls === 1) {
        yield {
          type: 'finish',
          reason: 'error',
          error: 'too much context',
          code: 'context_window_exceeded',
        }
      } else {
        yield { type: 'text-delta', delta: 'recovered' }
        yield {
          type: 'finish',
          reason: 'completed',
          response: { type: 'message', content: 'recovered' },
        }
      }
    },
  }
  const loop = new AgentLoop(policy('overflow checkpoint'))
  const disconnect = loop.connect(sessions, new InMemoryToolRegistry(), model)

  const result = await loop.run(session, 'current')

  assert.equal(result.content, 'recovered')
  assert.equal(requests.length, 2)
  const decisions = session.events.filter((event) => event.type === 'context-budget/decision')
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.trigger, 'context_overflow')
  assert.equal(decisions[0]?.outcome, 'compacted')
  assert.deepEqual(
    session.events
      .filter((event) => event.type === 'step/end')
      .slice(-2)
      .map((event) => event.outcome),
    ['failed', 'completed'],
  )
  disconnect()
})

test('no progress, exhausted recovery, and noncanonical failures preserve model errors', async () => {
  const sessions = new InMemorySessionStore()
  const session = sessions.create('no-progress')
  const overflow: ModelAdapter = {
    id: 'always-overflow',
    async *stream(): AsyncIterable<ModelStreamChunk> {
      yield {
        type: 'finish',
        reason: 'error',
        error: 'original overflow',
        code: 'context_window_exceeded',
      }
    },
  }
  const loop = new AgentLoop(policy())
  const disconnect = loop.connect(sessions, new InMemoryToolRegistry(), overflow)

  await assert.rejects(
    loop.run(session, 'only turn'),
    (error) => error instanceof ModelContextOverflowError && error.message === 'original overflow',
  )
  const decision = session.events.find((event) => event.type === 'context-budget/decision')
  assert.ok(decision?.type === 'context-budget/decision')
  assert.equal(decision.outcome, 'no_progress')
  assert.equal(session.events.at(-1)?.type, 'turn/end')
  disconnect()

  assert.throws(
    () =>
      new ContextBudgetPolicy({
        compactor: new SessionCompactor(new ModelSummaryAdapter(new ReplayModelAdapter('x', []))),
        thresholdRatio: 1,
      }),
    /thresholdRatio/,
  )
})

test('overflow retry limits preserve the final provider error after one useful retry', async () => {
  const sessions = new InMemorySessionStore()
  const session = sessions.create('retry-limit')
  appendTurn(session, 1)
  appendTurn(session, 2)
  let attempt = 0
  const model: ModelAdapter = {
    id: 'retry-limit-model',
    async *stream(): AsyncIterable<ModelStreamChunk> {
      attempt += 1
      yield {
        type: 'finish',
        reason: 'error',
        error: attempt === 1 ? 'first overflow' : 'final overflow',
        code: 'context_window_exceeded',
      }
    },
  }
  const loop = new AgentLoop(policy('one checkpoint'))
  const disconnect = loop.connect(sessions, new InMemoryToolRegistry(), model)

  await assert.rejects(
    loop.run(session, 'current'),
    (error) => error instanceof ModelContextOverflowError && error.message === 'final overflow',
  )
  assert.equal(attempt, 2)
  assert.equal(session.events.filter((event) => event.type === 'context-budget/decision').length, 1)
  assert.equal(session.events.at(-1)?.type, 'turn/end')
  disconnect()
})

test('proactive compaction failures are recorded without blocking the model request', async () => {
  const sessions = new InMemorySessionStore()
  const session = sessions.create('summary-failure')
  appendTurn(session, 1, 'a'.repeat(80))
  appendTurn(session, 2)
  const model = replayWithCapacity([{ type: 'message', content: 'still available' }], 40)
  const contextPolicy = new ContextBudgetPolicy({
    compactor: new SessionCompactor({
      id: 'failing-summary',
      async summarize(): Promise<string> {
        throw new Error('summary provider unavailable')
      },
    }),
  })
  const loop = new AgentLoop(contextPolicy)
  const disconnect = loop.connect(sessions, new InMemoryToolRegistry(), model)

  const result = await loop.run(session, 'current')

  assert.equal(result.content, 'still available')
  const decision = session.events.find((event) => event.type === 'context-budget/decision')
  assert.ok(decision?.type === 'context-budget/decision')
  assert.equal(decision.outcome, 'failed')
  assert.equal(decision.error, 'summary provider unavailable')
  assert.equal(
    session.events.some((event) => event.type === 'compaction/summary'),
    false,
  )
  disconnect()
})

test('cancellation during policy work aborts the turn without recording a failure decision', async () => {
  const sessions = new InMemorySessionStore()
  const session = sessions.create('policy-cancellation')
  appendTurn(session, 1, 'a'.repeat(80))
  appendTurn(session, 2)
  let entered!: () => void
  const summarizing = new Promise<void>((resolve) => {
    entered = resolve
  })
  const contextPolicy = new ContextBudgetPolicy({
    compactor: new SessionCompactor({
      id: 'cancellable-summary',
      summarize(_request, options): Promise<string> {
        entered()
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          })
        })
      },
    }),
  })
  const model = replayWithCapacity([{ type: 'message', content: 'unused' }], 40)
  const loop = new AgentLoop(contextPolicy)
  const disconnect = loop.connect(sessions, new InMemoryToolRegistry(), model)
  const controller = new AbortController()
  const reason = new Error('operator stopped compaction')

  const running = loop.run(session, 'current', { signal: controller.signal })
  await summarizing
  controller.abort(reason)

  await assert.rejects(
    running,
    (error) => error instanceof TurnCancelledError && error.cause === reason,
  )
  assert.equal(model.requests.length, 0)
  assert.equal(
    session.events.some((event) => event.type === 'context-budget/decision'),
    false,
  )
  const last = session.events.at(-1)
  assert.ok(last?.type === 'turn/end')
  assert.equal(last.status, 'aborted')
  disconnect()
})
