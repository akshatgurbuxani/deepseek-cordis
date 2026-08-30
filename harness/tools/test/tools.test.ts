import assert from 'node:assert/strict'
import test from 'node:test'

import type { JsonValue } from '@deepseek-cordis/protocol'
import { InMemoryToolRegistry, type ToolDefinition } from '@deepseek-cordis/tools'

function echoDefinition(name = 'echo'): ToolDefinition {
  return {
    name,
    description: 'Echo input',
    inputSchema: { type: 'object' },
    execute: (value) => value,
  }
}

test('registrations reject duplicates and dispose the owned definition once', () => {
  const registry = new InMemoryToolRegistry()
  const first = echoDefinition()
  const disposeFirst = registry.register(first)

  assert.equal(registry.size, 1)
  assert.throws(() => registry.register(echoDefinition()), /already registered/)
  disposeFirst()
  disposeFirst()
  assert.equal(registry.size, 0)

  registry.register(echoDefinition())
  disposeFirst()
  assert.equal(registry.size, 1)
})

test('schemas are isolated immutable snapshots', () => {
  const registry = new InMemoryToolRegistry()
  const definition = echoDefinition()
  registry.register(definition)

  const schemas = registry.schemas()
  ;(definition.inputSchema as { type: string }).type = 'mutated'

  assert.deepEqual(schemas, [{
    name: 'echo',
    description: 'Echo input',
    inputSchema: { type: 'object' },
  }])
  assert.equal(Object.isFrozen(schemas[0]), true)
  assert.equal(Object.isFrozen(schemas[0]?.inputSchema), true)
})

test('execution isolates arguments and successful output', async () => {
  const registry = new InMemoryToolRegistry()
  const input: { nested: { value: number } } = { nested: { value: 1 } }
  let received: JsonValue | undefined
  registry.register({
    name: 'capture',
    description: 'Capture input',
    inputSchema: {},
    execute(value) {
      received = value
      return { copied: value }
    },
  })

  const execution = await registry.execute('capture', input)
  input.nested.value = 2

  assert.deepEqual(received, { nested: { value: 1 } })
  assert.equal(received !== undefined && Object.isFrozen(received), true)
  assert.deepEqual(execution, {
    ok: true,
    output: { copied: { nested: { value: 1 } } },
  })
  assert.equal(execution.ok && Object.isFrozen(execution.output), true)
})

test('missing and throwing tools return explicit failures', async () => {
  const registry = new InMemoryToolRegistry()
  registry.register({
    name: 'boom',
    description: 'Throw an error',
    inputSchema: {},
    execute() { throw new Error('boom failed') },
  })
  registry.register({
    name: 'string-throw',
    description: 'Throw a string',
    inputSchema: {},
    execute() { throw 'string failed' },
  })

  assert.deepEqual(await registry.execute('missing', null), {
    ok: false,
    error: 'tool "missing" is not registered',
  })
  assert.deepEqual(await registry.execute('boom', null), {
    ok: false,
    error: 'boom failed',
  })
  assert.deepEqual(await registry.execute('string-throw', null), {
    ok: false,
    error: 'string failed',
  })
})

test('execution propagates cancellation instead of converting it into a tool result', async () => {
  const registry = new InMemoryToolRegistry()
  const controller = new AbortController()
  let receivedSignal: AbortSignal | undefined
  registry.register({
    name: 'cancel',
    description: 'Observe cancellation',
    inputSchema: {},
    async execute(_value, { signal }) {
      receivedSignal = signal
      controller.abort({ kind: 'user' })
      return 'must not publish'
    },
  })

  await assert.rejects(registry.execute('cancel', null, { signal: controller.signal }))
  assert.equal(receivedSignal, controller.signal)
})
