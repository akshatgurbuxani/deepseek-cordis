import assert from 'node:assert/strict'
import test from 'node:test'

import { UnavailableToolSandbox } from '@deepseek-cordis/sandbox'

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
