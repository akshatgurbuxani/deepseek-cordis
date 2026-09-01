import assert from 'node:assert/strict'
import test from 'node:test'

import { ProcessError } from '@deepseek-cordis/process'

test('process errors preserve a stable code without changing ordinary Error behavior', () => {
  const error = new ProcessError('PROCESS_NOT_ALLOWED', 'program is not allowed')
  assert.equal(error.name, 'ProcessError')
  assert.equal(error.code, 'PROCESS_NOT_ALLOWED')
  assert.match(error.message, /not allowed/)
})
