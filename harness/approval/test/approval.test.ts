import assert from 'node:assert/strict'
import test from 'node:test'

import { UnavailableApprovalService } from '@deepseek-cordis/approval'

const request = {
  sessionId: 'session-1', turnId: 'turn-1', callId: 'call-1',
  toolName: 'write', arguments: { path: 'note.txt' },
  risk: 'filesystem' as const, reason: 'write a file',
}

test('the headless approval provider fails closed and propagates cancellation', async () => {
  const service = new UnavailableApprovalService()
  assert.equal(await service.request(request), 'unavailable')

  const controller = new AbortController()
  controller.abort({ kind: 'user' })
  await assert.rejects(service.request({ ...request, signal: controller.signal }))
})
