import assert from 'node:assert/strict'
import test from 'node:test'

import { deepFreeze, snapshot } from '@deepseek-cordis/protocol'

test('snapshot clones and recursively freezes nested data', () => {
  const input = { nested: { values: [1, 2] } }
  const copy = snapshot(input)

  input.nested.values.push(3)

  assert.deepEqual(copy, { nested: { values: [1, 2] } })
  assert.notEqual(copy, input)
  assert.equal(Object.isFrozen(copy), true)
  assert.equal(Object.isFrozen(copy.nested), true)
  assert.equal(Object.isFrozen(copy.nested.values), true)
  assert.throws(() => copy.nested.values.push(4), TypeError)
})

test('deepFreeze handles repeated and cyclic object references', () => {
  const shared: { child?: object; self?: object } = {}
  shared.child = shared
  shared.self = shared

  assert.equal(deepFreeze(shared), shared)
  assert.equal(Object.isFrozen(shared), true)
})
