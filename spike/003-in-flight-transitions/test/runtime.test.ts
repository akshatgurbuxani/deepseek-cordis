import assert from 'node:assert/strict'
import test from 'node:test'

import { Runtime, service } from '../src/runtime.ts'

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

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap(errorMessages)]
  }
  return error instanceof Error ? [error.message] : [String(error)]
}

test('removing a provider during setup rolls back without publishing', async () => {
  const database = service<object>('database')
  const setupStarted = deferred()
  const finishSetup = deferred()
  const trace: string[] = []
  const runtime = new Runtime()

  const provider = runtime.add({
    name: 'database',
    provides: [[database, {}]],
    async setup(context) {
      await context.effect(() => {
        trace.push('acquire')
        return () => { trace.push('recover') }
      })
      setupStarted.resolve()
      await finishSetup.promise
    },
  })

  await setupStarted.promise
  runtime.remove(provider)
  assert.equal(runtime.get(database), undefined)

  finishSetup.resolve()
  await runtime.settle()

  assert.deepEqual(trace, ['acquire', 'recover'])
  assert.equal(provider.state, 'disposed')
  assert.equal(runtime.get(database), undefined)
})

test('replacement during provider setup activates only the newest identity', async () => {
  const database = service<{ id: string }>('database')
  const firstStarted = deferred()
  const finishFirst = deferred()
  const trace: string[] = []
  const runtime = new Runtime()

  const consumer = runtime.add({
    name: 'repository',
    requires: [database],
    setup(context) {
      trace.push(`repository:${context.get(database).id}`)
    },
  })
  const first = runtime.add({
    name: 'database-v1',
    provides: [[database, { id: 'v1' }]],
    async setup(context) {
      await context.effect(() => {
        trace.push('database-v1:acquire')
        return () => { trace.push('database-v1:recover') }
      })
      firstStarted.resolve()
      await finishFirst.promise
    },
  })

  await firstStarted.promise
  const second = runtime.replace(first, {
    name: 'database-v2',
    provides: [[database, { id: 'v2' }]],
    setup() {
      trace.push('database-v2:activate')
    },
  })

  finishFirst.resolve()
  await runtime.settle()

  assert.deepEqual(trace, [
    'database-v1:acquire',
    'database-v1:recover',
    'database-v2:activate',
    'repository:v2',
  ])
  assert.equal(first.state, 'disposed')
  assert.equal(second.state, 'active')
  assert.equal(consumer.state, 'active')
})

test('consumer setup becomes stale when its provider is removed', async () => {
  const database = service<object>('database')
  const consumerStarted = deferred()
  const finishConsumer = deferred()
  const trace: string[] = []
  const runtime = new Runtime()

  const provider = runtime.add({
    name: 'database',
    provides: [[database, {}]],
    async setup(context) {
      await context.effect(() => () => { trace.push('database:dispose') })
    },
  })
  await runtime.settle()

  const consumer = runtime.add({
    name: 'repository',
    requires: [database],
    async setup(context) {
      await context.effect(() => {
        trace.push('repository:acquire')
        return () => { trace.push('repository:rollback') }
      })
      consumerStarted.resolve()
      await finishConsumer.promise
    },
  })

  await consumerStarted.promise
  runtime.remove(provider)
  finishConsumer.resolve()
  await runtime.settle()

  assert.deepEqual(trace, [
    'repository:acquire',
    'repository:rollback',
    'database:dispose',
  ])
  assert.equal(consumer.state, 'pending')
  assert.equal(provider.state, 'disposed')
})

test('replacement waits for consumer cleanup against the old committed view', async () => {
  const database = service<{ id: string }>('database')
  const cleanupStarted = deferred()
  const finishCleanup = deferred()
  const trace: string[] = []
  const runtime = new Runtime()

  const first = runtime.add({
    name: 'database-v1',
    provides: [[database, { id: 'v1' }]],
    async setup(context) {
      await context.effect(() => () => { trace.push('database-v1:dispose') })
    },
  })
  const consumer = runtime.add({
    name: 'repository',
    requires: [database],
    async setup(context) {
      const id = context.get(database).id
      trace.push(`repository:${id}:activate`)
      await context.effect(() => async () => {
        trace.push(`repository:${id}:dispose:start`)
        cleanupStarted.resolve()
        await finishCleanup.promise
        trace.push(`repository:${context.get(database).id}:dispose:end`)
      })
    },
  })
  await runtime.settle()

  const second = runtime.replace(first, {
    name: 'database-v2',
    provides: [[database, { id: 'v2' }]],
    setup() {
      trace.push('database-v2:activate')
    },
  })

  await cleanupStarted.promise
  assert.equal(runtime.get(database), undefined)
  assert.equal(second.state, 'pending')
  assert.equal(consumer.state, 'disposing')

  finishCleanup.resolve()
  await runtime.settle()

  assert.deepEqual(trace, [
    'repository:v1:activate',
    'repository:v1:dispose:start',
    'repository:v1:dispose:end',
    'database-v1:dispose',
    'database-v2:activate',
    'repository:v2:activate',
  ])
  assert.equal(second.state, 'active')
  assert.equal(consumer.state, 'active')
})

test('provider recovery waits for direct and transitive consumers', async () => {
  const database = service<object>('database')
  const repository = service<object>('repository')
  const apiCleanupStarted = deferred()
  const finishApiCleanup = deferred()
  const repositoryCleanupStarted = deferred()
  const finishRepositoryCleanup = deferred()
  const trace: string[] = []
  const runtime = new Runtime()

  const provider = runtime.add({
    name: 'database',
    provides: [[database, {}]],
    async setup(context) {
      await context.effect(() => () => { trace.push('database:dispose') })
    },
  })
  runtime.add({
    name: 'repository',
    requires: [database],
    provides: [[repository, {}]],
    async setup(context) {
      await context.effect(() => async () => {
        trace.push('repository:dispose:start')
        repositoryCleanupStarted.resolve()
        await finishRepositoryCleanup.promise
        context.get(database)
        trace.push('repository:dispose:end')
      })
    },
  })
  runtime.add({
    name: 'api',
    requires: [repository],
    async setup(context) {
      await context.effect(() => async () => {
        trace.push('api:dispose:start')
        apiCleanupStarted.resolve()
        await finishApiCleanup.promise
        context.get(repository)
        trace.push('api:dispose:end')
      })
    },
  })
  await runtime.settle()

  runtime.remove(provider)
  await apiCleanupStarted.promise
  assert.deepEqual(trace, ['api:dispose:start'])

  finishApiCleanup.resolve()
  await repositoryCleanupStarted.promise
  assert.deepEqual(trace, [
    'api:dispose:start',
    'api:dispose:end',
    'repository:dispose:start',
  ])

  finishRepositoryCleanup.resolve()
  await runtime.settle()
  assert.deepEqual(trace, [
    'api:dispose:start',
    'api:dispose:end',
    'repository:dispose:start',
    'repository:dispose:end',
    'database:dispose',
  ])
})

test('rapid replacements converge without starting an obsolete middle provider', async () => {
  const database = service<{ id: string }>('database')
  const firstStarted = deferred()
  const finishFirst = deferred()
  const trace: string[] = []
  const runtime = new Runtime()

  const consumer = runtime.add({
    name: 'repository',
    requires: [database],
    setup(context) {
      trace.push(`repository:${context.get(database).id}`)
    },
  })
  const first = runtime.add({
    name: 'database-v1',
    provides: [[database, { id: 'v1' }]],
    async setup(context) {
      await context.effect(() => {
        trace.push('database-v1:acquire')
        return () => { trace.push('database-v1:recover') }
      })
      firstStarted.resolve()
      await finishFirst.promise
    },
  })

  await firstStarted.promise
  const second = runtime.replace(first, {
    name: 'database-v2',
    provides: [[database, { id: 'v2' }]],
    setup() {
      trace.push('database-v2:activate')
    },
  })
  const third = runtime.replace(second, {
    name: 'database-v3',
    provides: [[database, { id: 'v3' }]],
    setup() {
      trace.push('database-v3:activate')
    },
  })

  finishFirst.resolve()
  await runtime.settle()

  assert.deepEqual(trace, [
    'database-v1:acquire',
    'database-v1:recover',
    'database-v3:activate',
    'repository:v3',
  ])
  assert.equal(second.state, 'disposed')
  assert.equal(third.state, 'active')
  assert.equal(consumer.state, 'active')
})

test('an unrelated component can activate while another setup is blocked', async () => {
  const firstKey = service<object>('first')
  const secondKey = service<object>('second')
  const firstStarted = deferred()
  const finishFirst = deferred()
  const secondStarted = deferred()
  const finishSecond = deferred()
  const runtime = new Runtime()

  const first = runtime.add({
    name: 'first',
    provides: [[firstKey, {}]],
    async setup() {
      firstStarted.resolve()
      await finishFirst.promise
    },
  })
  await firstStarted.promise

  const second = runtime.add({
    name: 'second',
    provides: [[secondKey, {}]],
    async setup() {
      secondStarted.resolve()
      await finishSecond.promise
    },
  })
  await secondStarted.promise
  finishSecond.resolve()
  await nextTurn()

  assert.equal(first.state, 'activating')
  assert.equal(second.state, 'active')
  assert.notEqual(runtime.get(secondKey), undefined)

  runtime.remove(first)
  finishFirst.resolve()
  await runtime.settle()
  assert.equal(first.state, 'disposed')
  assert.equal(second.state, 'active')
})

test('repeated removal and settle calls join one cleanup transition', async () => {
  const cleanupStarted = deferred()
  const finishCleanup = deferred()
  const runtime = new Runtime()
  let cleanups = 0

  const fiber = runtime.add({
    name: 'component',
    async setup(context) {
      await context.effect(() => async () => {
        cleanups += 1
        cleanupStarted.resolve()
        await finishCleanup.promise
      })
    },
  })
  await runtime.settle()

  runtime.remove(fiber)
  runtime.remove(fiber)
  await cleanupStarted.promise
  const firstSettle = runtime.settle()
  const secondSettle = runtime.settle()
  finishCleanup.resolve()
  await Promise.all([firstSettle, secondSettle])

  assert.equal(cleanups, 1)
  assert.equal(fiber.state, 'disposed')
})

test('activation failure rolls back once and remains observable without retrying', async () => {
  const broken = service<object>('broken')
  const runtime = new Runtime()
  let resources = 0
  let attempts = 0

  const fiber = runtime.add({
    name: 'broken',
    provides: [[broken, {}]],
    async setup(context) {
      attempts += 1
      await context.effect(() => {
        resources += 1
        return () => { resources -= 1 }
      })
      throw new Error('activation failed')
    },
  })

  await assert.rejects(runtime.settle(), /activation failed/)
  assert.equal(fiber.state, 'pending')
  assert.match(String(fiber.lastError), /activation failed/)
  assert.equal(resources, 0)
  assert.equal(runtime.get(broken), undefined)

  runtime.add({ name: 'unrelated', setup() {} })
  await runtime.settle()
  assert.equal(attempts, 1)
})

test('consumer cleanup failure is observable but cannot strand provider recovery', async () => {
  const database = service<object>('database')
  const trace: string[] = []
  const runtime = new Runtime()

  const provider = runtime.add({
    name: 'database',
    provides: [[database, {}]],
    async setup(context) {
      await context.effect(() => () => { trace.push('database:dispose') })
    },
  })
  const consumer = runtime.add({
    name: 'repository',
    requires: [database],
    async setup(context) {
      await context.effect(() => () => {
        trace.push('repository:dispose')
        throw new Error('repository cleanup failed')
      })
    },
  })
  await runtime.settle()

  runtime.remove(provider)
  const error = await runtime.settle().then(
    () => undefined,
    (reason: unknown) => reason,
  )

  assert.ok(error instanceof AggregateError)
  assert.ok(errorMessages(error).includes('repository cleanup failed'))
  assert.deepEqual(trace, ['repository:dispose', 'database:dispose'])
  assert.equal(consumer.state, 'pending')
  assert.equal(provider.state, 'disposed')
  await runtime.settle()
})

test('settle includes mutations accepted while an earlier transition is running', async () => {
  const firstStarted = deferred()
  const finishFirst = deferred()
  const secondStarted = deferred()
  const finishSecond = deferred()
  const runtime = new Runtime()
  let settled = false

  runtime.add({
    name: 'first',
    async setup() {
      firstStarted.resolve()
      await finishFirst.promise
    },
  })
  await firstStarted.promise

  const settlement = runtime.settle().then(() => { settled = true })
  runtime.add({
    name: 'second',
    async setup() {
      secondStarted.resolve()
      await finishSecond.promise
    },
  })
  await secondStarted.promise
  finishFirst.resolve()
  await nextTurn()
  assert.equal(settled, false)

  finishSecond.resolve()
  await settlement
  assert.equal(settled, true)
})
