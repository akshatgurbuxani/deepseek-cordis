import assert from 'node:assert/strict'
import test from 'node:test'

import { ProfiledToolSandbox, UnavailableToolSandbox } from '@deepseek-cordis/sandbox'

const request = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  callId: 'call-1',
  toolName: 'write',
  arguments: null,
  risk: 'filesystem' as const,
  profile: 'workspace-write',
}

test('the absent sandbox provider fails closed and propagates cancellation', async () => {
  const sandbox = new UnavailableToolSandbox()
  assert.deepEqual(await sandbox.prepare(request), {
    ok: false,
    reason: 'no sandbox provider is available',
  })

  const controller = new AbortController()
  controller.abort({ kind: 'user' })
  await assert.rejects(sandbox.prepare({ ...request, signal: controller.signal }))
})

test('profile routing selects one exact provider and fails closed for missing routes', async () => {
  const seen: string[] = []
  const routed = new ProfiledToolSandbox({
    alpha: {
      async prepare(candidate) {
        seen.push(candidate.callId)
        return { ok: false, reason: 'alpha declined' }
      },
    },
  })

  assert.deepEqual(await routed.prepare({ ...request, profile: 'alpha' }), {
    ok: false,
    reason: 'alpha declined',
  })
  assert.deepEqual(seen, ['call-1'])
  assert.deepEqual(await routed.prepare({ ...request, profile: 'missing' }), {
    ok: false,
    reason: 'no sandbox provider is registered for profile "missing"',
  })
  assert.throws(
    () => new ProfiledToolSandbox({ ' ': new UnavailableToolSandbox() }),
    /must not be empty/,
  )
})
