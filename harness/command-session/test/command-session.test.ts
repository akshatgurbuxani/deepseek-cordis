import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCompactCommand,
  createInspectCommand,
  formatSessionInspection,
  inspectSession,
} from '@deepseek-cordis/command-session'
import { InMemoryCommandRegistry } from '@deepseek-cordis/commands'
import { SessionCompactor } from '@deepseek-cordis/compaction'
import { InMemorySession } from '@deepseek-cordis/session'

function appendTurn(session: InMemorySession, turn: number): void {
  const turnId = `${session.id}:turn:${turn}`
  session.append({ type: 'turn/start', turnId })
  session.append({ type: 'user/message', turnId, content: `turn ${turn}` })
  session.append({ type: 'assistant/message', turnId, content: `answer ${turn}` })
  session.append({ type: 'turn/end', turnId, status: 'completed' })
}

test('session inspection is a pure durable projection', () => {
  const session = new InMemorySession('inspect')
  appendTurn(session, 1)
  const inspection = inspectSession(session)

  assert.deepEqual(inspection, {
    id: 'inspect', events: 4, turns: 1, completedTurns: 1,
    interruptedTurns: 0, failedTurns: 0, openTurn: false,
    surfaceMessages: 2, compactions: 0, lastSequence: 4,
  })
  assert.match(formatSessionInspection(inspection), /Turns: 1 \(1 completed/)
})

test('inspect and compact commands use the registry and authoritative compactor', async () => {
  const session = new InMemorySession('session-commands')
  appendTurn(session, 1)
  appendTurn(session, 2)
  const compactor = new SessionCompactor({
    id: 'command-test', summarize: async () => 'checkpoint',
  })
  const commands = new InMemoryCommandRegistry()
  commands.register(createInspectCommand())
  commands.register(createCompactCommand(compactor))

  const inspected = await commands.execute(session, '/inspect')
  assert.match(inspected?.result.text ?? '', /Session: session-commands/)
  const compacted = await commands.execute(session, '/compact')
  assert.equal(compacted?.result.kind, 'success')
  assert.match(compacted?.result.text ?? '', /Compacted 2 model-visible messages/)
  assert.equal(
    compacted?.result.kind === 'success' ? compacted.result.sourceSequence : undefined,
    session.events.find((event) => event.type === 'compaction/summary')?.sequence,
  )
  assert.deepEqual(session.projectMessages(), [
    { role: 'user', content: 'checkpoint' },
    { role: 'user', content: 'turn 2' },
    { role: 'assistant', content: 'answer 2' },
  ])

  const invalid = await commands.execute(session, '/compact zero')
  assert.deepEqual(invalid?.result, {
    kind: 'error', text: 'compact expects an optional positive integer retain-turn count',
  })
})
