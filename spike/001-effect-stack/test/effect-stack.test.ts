import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { EffectStack } from '../src/effect-stack.ts'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('synchronous effects dispose in reverse registration order', async () => {
  const trace: string[] = []
  const scope = new EffectStack()

  await scope.effect(() => () => { trace.push('first') })
  await scope.effect(() => () => { trace.push('second') })
  await scope.effect(() => () => { trace.push('third') })

  await scope.dispose()

  assert.deepEqual(trace, ['third', 'second', 'first'])
  assert.equal(scope.state, 'disposed')
  assert.equal(scope.size, 0)
})

test('one effect unwinds its async acquisition steps sequentially', async () => {
  const trace: string[] = []
  const scope = new EffectStack()

  await scope.effect(function* () {
    yield async () => {
      trace.push('first:start')
      await Promise.resolve()
      trace.push('first:end')
    }
    yield async () => {
      trace.push('second:start')
      await Promise.resolve()
      trace.push('second:end')
    }
  })

  await scope.dispose()

  assert.deepEqual(trace, [
    'second:start',
    'second:end',
    'first:start',
    'first:end',
  ])
})

test('asynchronous setup can return several completed acquisition steps', async () => {
  const trace: string[] = []
  const scope = new EffectStack()

  await scope.effect(async () => [
    () => { trace.push('first') },
    () => { trace.push('second') },
  ])

  await scope.dispose()
  assert.deepEqual(trace, ['second', 'first'])
})

test('independent async effects start in reverse order and may overlap', async () => {
  const trace: string[] = []
  const firstGate = deferred()
  const secondGate = deferred()
  const scope = new EffectStack()

  await scope.effect(() => async () => {
    trace.push('first:start')
    await firstGate.promise
    trace.push('first:end')
  })
  await scope.effect(() => async () => {
    trace.push('second:start')
    await secondGate.promise
    trace.push('second:end')
  })

  const disposal = scope.dispose()
  await Promise.resolve()
  assert.deepEqual(trace, ['second:start', 'first:start'])

  firstGate.resolve()
  await Promise.resolve()
  assert.deepEqual(trace, ['second:start', 'first:start', 'first:end'])

  secondGate.resolve()
  await disposal
  assert.deepEqual(trace, [
    'second:start',
    'first:start',
    'first:end',
    'second:end',
  ])
})

test('explicit and owner disposal recover an effect only once', async () => {
  const scope = new EffectStack()
  let recoveries = 0
  const disposeEffect = await scope.effect(() => () => { recoveries += 1 })

  const first = disposeEffect()
  const second = disposeEffect()
  assert.equal(first, second)

  await Promise.all([first, scope.dispose(), scope.dispose()])
  assert.equal(recoveries, 1)
})

test('failed asynchronous acquisition recovers only completed steps', async () => {
  const trace: string[] = []
  const scope = new EffectStack()

  await assert.rejects(
    scope.effect(async function* () {
      trace.push('acquire:first')
      yield () => { trace.push('recover:first') }
      await Promise.resolve()
      trace.push('acquire:second')
      yield () => { trace.push('recover:second') }
      throw new Error('third acquisition failed')
    }),
    /third acquisition failed/,
  )

  assert.deepEqual(trace, [
    'acquire:first',
    'acquire:second',
    'recover:second',
    'recover:first',
  ])
  assert.equal(scope.size, 0)
  await scope.dispose()
  assert.equal(trace.length, 4)
})

test('owner disposal joins setup already in flight without deadlocking', async () => {
  const acquired = deferred()
  const continueSetup = deferred()
  const trace: string[] = []
  const scope = new EffectStack()

  const effect = scope.effect(async function* () {
    trace.push('acquire')
    acquired.resolve()
    yield () => { trace.push('recover') }
    await continueSetup.promise
    throw new Error('setup failed while disposal waited')
  })

  await acquired.promise
  const disposal = scope.dispose()
  continueSetup.resolve()

  await assert.rejects(effect, /setup failed while disposal waited/)
  await disposal
  assert.deepEqual(trace, ['acquire', 'recover'])
  assert.equal(scope.state, 'disposed')
  assert.equal(scope.size, 0)
})

test('disposing one child leaves its sibling alive', async () => {
  const trace: string[] = []
  const parent = new EffectStack()
  const firstChild = parent.child()
  const secondChild = parent.child()

  await firstChild.effect(() => () => { trace.push('first-child') })
  await secondChild.effect(() => () => { trace.push('second-child') })

  await firstChild.dispose()
  assert.deepEqual(trace, ['first-child'])
  assert.equal(secondChild.state, 'active')

  await parent.dispose()
  assert.deepEqual(trace, ['first-child', 'second-child'])
  assert.equal(secondChild.state, 'disposed')
})

test('failed activation leaves no timer, listener, or service behind', async () => {
  const scope = new EffectStack()
  const events = new EventEmitter()
  const services = new Map<string, object>()
  let ticks = 0
  let calls = 0

  await assert.rejects(
    scope.effect(function* () {
      const timer = setInterval(() => { ticks += 1 }, 5)
      yield () => { clearInterval(timer) }

      const listener = () => { calls += 1 }
      events.on('message', listener)
      yield () => { events.off('message', listener) }

      services.set('example', {})
      yield () => { services.delete('example') }

      throw new Error('activation failed')
    }),
    /activation failed/,
  )

  events.emit('message')
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(ticks, 0)
  assert.equal(calls, 0)
  assert.equal(events.listenerCount('message'), 0)
  assert.equal(services.has('example'), false)
})

test('disposal restores declared state but cannot retract an external emission', async () => {
  const scope = new EffectStack()
  const localRegistrations = new Set<string>()
  const externalHistory: string[] = []

  await scope.effect(() => {
    localRegistrations.add('registration')
    externalHistory.push('message sent')
    return () => { localRegistrations.delete('registration') }
  })

  await scope.dispose()

  assert.deepEqual([...localRegistrations], [])
  assert.deepEqual(externalHistory, ['message sent'])
})

test('one failing disposer does not prevent the remaining cleanup', async () => {
  const trace: string[] = []
  const scope = new EffectStack()

  await scope.effect(function* () {
    yield () => { trace.push('first') }
    yield () => {
      trace.push('failing')
      throw new Error('cleanup failed')
    }
    yield () => { trace.push('last') }
  })

  await assert.rejects(scope.dispose(), AggregateError)
  assert.deepEqual(trace, ['last', 'failing', 'first'])
  assert.equal(scope.state, 'disposed')
  assert.equal(scope.size, 0)
})

test('a disposing or disposed scope rejects new acquisitions', async () => {
  const gate = deferred()
  const scope = new EffectStack()

  await scope.effect(() => async () => { await gate.promise })
  const disposal = scope.dispose()

  assert.throws(() => scope.effect(() => undefined), /scope is disposing/)
  gate.resolve()
  await disposal
  assert.throws(() => scope.effect(() => undefined), /scope is disposed/)
})
