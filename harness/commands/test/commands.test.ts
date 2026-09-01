import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type CommandDefinition,
  InMemoryCommandRegistry,
  parseCommand,
} from '@deepseek-cordis/commands'
import { InMemorySession } from '@deepseek-cordis/session'

function echoCommand(): CommandDefinition {
  return {
    name: 'echo',
    description: 'Echo command input',
    inputHint: '<text>',
    handler: ({ rawInput }) => ({ kind: 'success', text: rawInput.trim() }),
  }
}

test('command parsing is strict and preserves the exact suffix', () => {
  assert.deepEqual(parseCommand('/compact  2'), { name: 'compact', rawInput: '  2' })
  assert.deepEqual(parseCommand('/inspect'), { name: 'inspect', rawInput: '' })
  for (const input of ['inspect', ' /inspect', '/', '/UPPER', '/bad.name', '/inspect!']) {
    assert.equal(parseCommand(input), undefined)
  }
})

test('registrations are immutable, discoverable, unique, and reversibly owned', () => {
  const registry = new InMemoryCommandRegistry()
  const definition = echoCommand()
  const dispose = registry.register(definition)
  ;(definition as { description: string }).description = 'mutated'

  assert.deepEqual(registry.list(), [
    {
      name: 'echo',
      description: 'Echo command input',
      inputHint: '<text>',
    },
  ])
  assert.deepEqual(registry.find('echo'), registry.list()[0])
  assert.equal(Object.isFrozen(registry.find('echo')), true)
  assert.throws(() => registry.register(echoCommand()), /already registered/)
  assert.throws(
    () =>
      registry.register({
        ...echoCommand(),
        name: 'Bad',
      }),
    /invalid command name/,
  )
  assert.throws(
    () =>
      registry.register({
        ...echoCommand(),
        name: 'blank',
        description: ' ',
      }),
    /empty description/,
  )
  assert.throws(
    () =>
      registry.register({
        ...echoCommand(),
        name: 'policy',
        cancellation: 'invalid' as never,
      }),
    /invalid cancellation policy/,
  )

  dispose()
  dispose()
  assert.equal(registry.size, 0)
})

test('dispatch records a standalone lifecycle without entering model history', async () => {
  const registry = new InMemoryCommandRegistry()
  registry.register(echoCommand())
  const session = new InMemorySession('commands')

  assert.equal(await registry.execute(session, 'not a command'), undefined)
  assert.equal(await registry.execute(session, '/missing'), undefined)
  assert.deepEqual(session.events, [])
  const execution = await registry.execute(session, '/echo  hello')

  assert.deepEqual(execution, {
    commandId: 'commands:command:1',
    name: 'echo',
    result: { kind: 'success', text: 'hello' },
  })
  assert.deepEqual(session.events, [
    {
      type: 'command/run',
      turnId: 'commands:command:1',
      sequence: 1,
      commandId: 'commands:command:1',
      name: 'echo',
      rawInput: '  hello',
    },
    {
      type: 'command/done',
      turnId: 'commands:command:1',
      sequence: 2,
      commandId: 'commands:command:1',
      name: 'echo',
      result: { kind: 'success', text: 'hello' },
    },
  ])
  assert.deepEqual(session.projectMessages(), [])
})

test('handler failures, invalid results, and cancellation settle as errors', async () => {
  const registry = new InMemoryCommandRegistry()
  registry.register({
    name: 'throw',
    description: 'Throw',
    handler() {
      throw new Error('failed')
    },
  })
  registry.register({
    name: 'invalid',
    description: 'Invalid',
    handler: () => null as never,
  })
  registry.register({
    name: 'cancel',
    description: 'Cancel',
    handler: (_invocation) => {
      return { kind: 'success', text: 'must not escape' }
    },
  })
  registry.register({
    name: 'future',
    description: 'Invalid provenance',
    handler: () => ({ kind: 'success', sourceSequence: 999 }),
  })
  const session = new InMemorySession('errors')

  assert.equal((await registry.execute(session, '/throw'))?.result.text, 'failed')
  assert.equal(
    (await registry.execute(session, '/invalid'))?.result.text,
    'command returned an invalid result',
  )
  assert.equal(
    (await registry.execute(session, '/future'))?.result.text,
    'command returned an invalid source sequence',
  )
  const controller = new AbortController()
  controller.abort({ kind: 'user' })
  await assert.rejects(registry.execute(session, '/cancel', { signal: controller.signal }))
  assert.equal(session.events.filter((event) => event.type === 'command/run').length, 3)
})

test('command admission excludes open turns and concurrent session commands', async () => {
  const registry = new InMemoryCommandRegistry()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  registry.register({
    name: 'wait',
    description: 'Wait',
    handler: async () => {
      await blocked
      return { kind: 'success' }
    },
  })
  const open = new InMemorySession('open')
  open.append({ type: 'turn/start', turnId: 'open:turn:1' })
  await assert.rejects(registry.execute(open, '/wait'), /while a turn is open/)
  assert.equal(
    open.events.some((event) => event.type === 'command/run'),
    false,
  )

  const session = new InMemorySession('serial')
  const first = registry.execute(session, '/wait')
  await assert.rejects(registry.execute(session, '/wait'), /concurrent commands/)
  assert.equal(session.events.filter((event) => event.type === 'command/run').length, 1)
  release()
  assert.equal((await first)?.result.kind, 'success')
  assert.equal(session.events.filter((event) => event.type === 'command/done').length, 1)
})

test('admission-only commands finish an atomic commit after in-flight cancellation', async () => {
  const registry = new InMemoryCommandRegistry()
  const cooperative = new AbortController()
  const atomic = new AbortController()
  registry.register({
    name: 'cooperative',
    description: 'Cooperative cancellation',
    handler: () => {
      cooperative.abort(new Error('cancel cooperative'))
      return { kind: 'success', text: 'not committed' }
    },
  })
  registry.register({
    name: 'atomic',
    description: 'Admission-only cancellation',
    cancellation: 'admission-only',
    handler: () => {
      atomic.abort(new Error('cancel after commit starts'))
      return { kind: 'success', text: 'committed' }
    },
  })
  const session = new InMemorySession('atomic-command')

  assert.deepEqual(
    (await registry.execute(session, '/cooperative', { signal: cooperative.signal }))?.result,
    { kind: 'error', text: 'command cancelled' },
  )
  assert.deepEqual(
    (await registry.execute(session, '/atomic', { signal: atomic.signal }))?.result,
    { kind: 'success', text: 'committed' },
  )
})
