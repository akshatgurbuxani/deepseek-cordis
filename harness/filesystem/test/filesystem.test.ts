import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FILESYSTEM_ERROR_CODES,
  FileObservationPolicy,
  FileSystemError,
  type FileTarget,
} from '@deepseek-cordis/filesystem'

const target = (path: string): FileTarget => ({ key: `test:${path}`, displayPath: path })

test('filesystem errors expose stable codes in their public message', () => {
  assert.equal(new Set(FILESYSTEM_ERROR_CODES).size, FILESYSTEM_ERROR_CODES.length)
  const error = new FileSystemError('FS_STALE_VERSION', 'notes.txt changed')
  assert.equal(error.code, 'FS_STALE_VERSION')
  assert.equal(error.name, 'FileSystemError')
  assert.equal(error.message, 'FS_STALE_VERSION: notes.txt changed')
})

test('observation policy separates sessions and requires content before edit', () => {
  const policy = new FileObservationPolicy()
  const first = target('notes.txt')
  const sameIdentity = target('notes.txt')

  assert.throws(() => policy.writeGuard('a', first), /FS_NOT_OBSERVED/)
  policy.observeAbsent('a', first)
  assert.equal(policy.writeGuard('a', sameIdentity), null)
  assert.throws(() => policy.editGuard('a', first), /must be read before editing/)

  policy.observeMetadata('a', first, 'v1')
  assert.equal(policy.writeGuard('a', sameIdentity), 'v1')
  assert.throws(() => policy.editGuard('a', first), /FS_NOT_OBSERVED/)

  policy.observeContent('a', sameIdentity, 'v2')
  assert.equal(policy.writeGuard('a', first), 'v2')
  assert.equal(policy.editGuard('a', first), 'v2')
  assert.throws(() => policy.writeGuard('b', first), /FS_NOT_OBSERVED/)

  policy.forget('a', first)
  assert.throws(() => policy.writeGuard('a', first), /FS_NOT_OBSERVED/)
  policy.observeAbsent('a', first)
  policy.observeAbsent('ab', first)
  policy.clearSession('a')
  assert.throws(() => policy.writeGuard('a', first), /FS_NOT_OBSERVED/)
  assert.equal(policy.writeGuard('ab', first), null)
})
