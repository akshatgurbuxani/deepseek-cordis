import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_HARNESS_PROFILE,
  HARNESS_PROFILE_SCHEMA_VERSION,
  HARNESS_TOOL_IDS,
  parseHarnessProfile,
  validateHarnessProfile,
} from '@deepseek-cordis/configuration'

test('a minimal versioned profile expands to immutable explicit defaults', () => {
  const profile = validateHarnessProfile({ schemaVersion: HARNESS_PROFILE_SCHEMA_VERSION })

  assert.deepEqual(profile, DEFAULT_HARNESS_PROFILE)
  assert.deepEqual(profile.model, { provider: 'openrouter', id: 'openrouter/free' })
  assert.deepEqual(profile.persistence, { kind: 'memory' })
  assert.deepEqual(profile.tools.enabled, HARNESS_TOOL_IDS)
  assert.deepEqual(profile.prompt, { identity: true, workspaceGuidance: true })
  assert.deepEqual(profile.approval, { default: 'ask' })
  assert.deepEqual(profile.context, {
    thresholdRatio: 0.8,
    retainTurns: 1,
    maxOverflowRetries: 1,
  })
  assert.equal(Object.isFrozen(profile), true)
  assert.equal(Object.isFrozen(profile.tools.enabled), true)
})

test('all profile choices normalize without retaining caller-owned structures', () => {
  const source = {
    schemaVersion: 1,
    name: 'coding',
    model: { provider: 'replay', contextWindow: 4096 },
    workspace: { root: './project', maxFileBytes: 2048 },
    persistence: { kind: 'file', directory: './sessions' },
    tools: { enabled: ['add', 'workspace.read', 'workspace.edit'] },
    prompt: { identity: false, workspaceGuidance: false, persona: '  Be precise.  ' },
    approval: { default: 'deny' },
    context: { thresholdRatio: 0.65, retainTurns: 2, maxOverflowRetries: 0 },
  }
  const profile = validateHarnessProfile(source)
  source.name = 'mutated'
  source.tools.enabled.push('workspace.write')

  assert.deepEqual(profile, {
    schemaVersion: 1,
    name: 'coding',
    model: { provider: 'replay', contextWindow: 4096 },
    workspace: { root: './project', maxFileBytes: 2048 },
    persistence: { kind: 'file', directory: './sessions' },
    tools: { enabled: ['add', 'workspace.read', 'workspace.edit'] },
    prompt: { identity: false, workspaceGuidance: false, persona: 'Be precise.' },
    approval: { default: 'deny' },
    context: { thresholdRatio: 0.65, retainTurns: 2, maxOverflowRetries: 0 },
  })
})

test('JSON parsing reports source provenance without exposing document content', () => {
  assert.equal(parseHarnessProfile('{"schemaVersion":1}', 'coding.json').name, 'default')
  assert.throws(
    () => parseHarnessProfile('{secret', 'private.json'),
    (error: unknown) => {
      assert.match((error as Error).message, /^private\.json: invalid JSON$/)
      assert.equal((error as Error).message.includes('secret'), false)
      return true
    },
  )
})

test('schema, objects, exact keys, and discriminated fields fail loud', () => {
  const invalid: readonly [unknown, RegExp][] = [
    [null, /profile must be an object/],
    [{}, /schemaVersion must be 1/],
    [{ schemaVersion: 2 }, /schemaVersion must be 1/],
    [{ schemaVersion: 1, typo: true }, /unknown field "typo"/],
    [{ schemaVersion: 1, name: '  ' }, /name must be a non-empty string/],
    [{ schemaVersion: 1, model: { provider: 'other' } }, /model\.provider/],
    [{ schemaVersion: 1, model: { provider: 'replay', id: 'wrong' } }, /not allowed for replay/],
    [
      { schemaVersion: 1, model: { provider: 'openrouter', extra: true } },
      /model contains unknown field/,
    ],
    [
      { schemaVersion: 1, persistence: { kind: 'memory', directory: 'x' } },
      /not allowed for memory/,
    ],
    [{ schemaVersion: 1, persistence: { kind: 'database' } }, /persistence\.kind/],
    [{ schemaVersion: 1, persistence: { kind: 'file' } }, /persistence\.directory/],
  ]
  for (const [value, expected] of invalid) {
    assert.throws(() => validateHarnessProfile(value, 'test profile'), expected)
  }
})

test('bounds, booleans, tools, and policy vocabulary are validated', () => {
  const invalid: readonly [unknown, RegExp][] = [
    [{ workspace: { maxFileBytes: 0 } }, /workspace\.maxFileBytes/],
    [{ model: { provider: 'openrouter', contextWindow: 1.5 } }, /model\.contextWindow/],
    [{ tools: { enabled: 'add' } }, /tools\.enabled must be an array/],
    [{ tools: { enabled: ['unknown'] } }, /not a recognized tool id/],
    [{ tools: { enabled: ['add', 'add'] } }, /must not contain duplicates/],
    [{ prompt: { identity: 'yes' } }, /prompt\.identity must be a boolean/],
    [{ prompt: { persona: ' ' } }, /prompt\.persona must be a non-empty string/],
    [{ approval: { default: 'allow' } }, /approval\.default/],
    [{ context: { thresholdRatio: 1 } }, /context\.thresholdRatio/],
    [{ context: { retainTurns: 0 } }, /context\.retainTurns/],
    [{ context: { maxOverflowRetries: -1 } }, /context\.maxOverflowRetries/],
  ]
  for (const [partial, expected] of invalid) {
    assert.throws(
      () => validateHarnessProfile({ schemaVersion: 1, ...(partial as object) }),
      expected,
    )
  }
})

test('tool selections normalize to canonical presentation order', () => {
  const profile = validateHarnessProfile({
    schemaVersion: 1,
    tools: { enabled: ['workspace.edit', 'add', 'workspace.read'] },
  })
  assert.deepEqual(profile.tools.enabled, ['add', 'workspace.read', 'workspace.edit'])
})
