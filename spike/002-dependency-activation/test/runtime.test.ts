import assert from 'node:assert/strict'
import test from 'node:test'

import { Runtime, service } from '../src/runtime.ts'

test('a consumer registered before its provider stays pending and then activates', async () => {
  const database = service<{ id: string }>('database')
  const trace: string[] = []
  const runtime = new Runtime()

  const consumer = await runtime.add({
    name: 'repository',
    requires: [database],
    setup(context) {
      trace.push(`repository:${context.get(database).id}`)
    },
  })

  assert.equal(consumer.state, 'pending')
  assert.equal(trace.length, 0)

  const provider = await runtime.add({
    name: 'database',
    provides: [[database, { id: 'primary' }]],
    setup() {
      trace.push('database')
    },
  })

  assert.equal(provider.state, 'active')
  assert.equal(consumer.state, 'active')
  assert.deepEqual(trace, ['database', 'repository:primary'])
})

test('a consumer requiring several services activates once after the final provider', async () => {
  const database = service<object>('database')
  const logger = service<object>('logger')
  const runtime = new Runtime()
  let activations = 0

  const consumer = await runtime.add({
    name: 'repository',
    requires: [database, logger],
    setup() {
      activations += 1
    },
  })
  await runtime.add({
    name: 'database',
    provides: [[database, {}]],
    setup() {},
  })

  assert.equal(consumer.state, 'pending')
  assert.equal(activations, 0)

  await runtime.add({
    name: 'logger',
    provides: [[logger, {}]],
    setup() {},
  })

  assert.equal(consumer.state, 'active')
  assert.equal(activations, 1)
})

test('failed provider setup rolls back its effects and publishes no service', async () => {
  const database = service<object>('database')
  const runtime = new Runtime()
  let registrations = 0

  const consumer = await runtime.add({
    name: 'repository',
    requires: [database],
    setup() {},
  })

  await assert.rejects(
    runtime.add({
      name: 'broken-database',
      provides: [[database, {}]],
      async setup(context) {
        await context.effect(() => {
          registrations += 1
          return () => {
            registrations -= 1
          }
        })
        throw new Error('database setup failed')
      },
    }),
    /database setup failed/,
  )

  assert.equal(registrations, 0)
  assert.equal(runtime.get(database), undefined)
  assert.equal(consumer.state, 'pending')
})

test('provider removal drains transitive consumers before provider cleanup', async () => {
  const database = service<{ alive: boolean }>('database')
  const repository = service<object>('repository')
  const trace: string[] = []
  const db = { alive: true }
  const runtime = new Runtime()

  const provider = await runtime.add({
    name: 'database',
    provides: [[database, db]],
    async setup(context) {
      await context.effect(() => () => {
        db.alive = false
        trace.push('database:dispose')
      })
    },
  })
  const middle = await runtime.add({
    name: 'repository',
    requires: [database],
    provides: [[repository, {}]],
    async setup(context) {
      await context.effect(() => () => {
        trace.push(`repository:dispose:database-alive=${context.get(database).alive}`)
      })
    },
  })
  const leaf = await runtime.add({
    name: 'api',
    requires: [repository],
    async setup(context) {
      await context.effect(() => () => {
        context.get(repository)
        trace.push('api:dispose')
      })
    },
  })

  await runtime.remove(provider)

  assert.deepEqual(trace, [
    'api:dispose',
    'repository:dispose:database-alive=true',
    'database:dispose',
  ])
  assert.equal(provider.state, 'disposed')
  assert.equal(middle.state, 'pending')
  assert.equal(leaf.state, 'pending')
})

test('removing a provider leaves an unrelated subgraph active', async () => {
  const database = service<object>('database')
  const logger = service<object>('logger')
  const runtime = new Runtime()

  const databaseFiber = await runtime.add({
    name: 'database',
    provides: [[database, {}]],
    setup() {},
  })
  const repositoryFiber = await runtime.add({
    name: 'repository',
    requires: [database],
    setup() {},
  })
  const loggerFiber = await runtime.add({
    name: 'logger',
    provides: [[logger, {}]],
    setup() {},
  })
  const metricsFiber = await runtime.add({
    name: 'metrics',
    requires: [logger],
    setup() {},
  })

  await runtime.remove(databaseFiber)

  assert.equal(repositoryFiber.state, 'pending')
  assert.equal(loggerFiber.state, 'active')
  assert.equal(metricsFiber.state, 'active')
})

test('replacement drains old effects and reactivates with a fresh provider identity', async () => {
  const database = service<{ id: string }>('database')
  const trace: string[] = []
  const runtime = new Runtime()

  const first = await runtime.add({
    name: 'database-v1',
    provides: [[database, { id: 'v1' }]],
    async setup(context) {
      await context.effect(() => () => {
        trace.push('database-v1:dispose')
      })
    },
  })
  const consumer = await runtime.add({
    name: 'repository',
    requires: [database],
    async setup(context) {
      const id = context.get(database).id
      trace.push(`repository:${id}:activate`)
      await context.effect(() => () => {
        trace.push(`repository:${id}:dispose`)
      })
    },
  })

  const second = await runtime.replace(first, {
    name: 'database-v2',
    provides: [[database, { id: 'v2' }]],
    setup() {
      trace.push('database-v2:activate')
    },
  })

  assert.deepEqual(trace, [
    'repository:v1:activate',
    'repository:v1:dispose',
    'database-v1:dispose',
    'database-v2:activate',
    'repository:v2:activate',
  ])
  assert.equal(first.state, 'disposed')
  assert.equal(second.state, 'active')
  assert.equal(consumer.state, 'active')
})

test('duplicate providers are rejected by typed service identity', async () => {
  const database = service<object>('database')
  const runtime = new Runtime()

  await runtime.add({
    name: 'first-database',
    provides: [[database, {}]],
    setup() {},
  })

  await assert.rejects(
    runtime.add({
      name: 'second-database',
      provides: [[database, {}]],
      setup() {},
    }),
    /database.*already provided by component.*first-database/,
  )
})

test('replacement is validated before the old provider is disturbed', async () => {
  const database = service<object>('database')
  const logger = service<object>('logger')
  const runtime = new Runtime()
  let databaseDisposals = 0

  const databaseFiber = await runtime.add({
    name: 'database',
    provides: [[database, {}]],
    async setup(context) {
      await context.effect(() => () => {
        databaseDisposals += 1
      })
    },
  })
  await runtime.add({
    name: 'logger',
    provides: [[logger, {}]],
    setup() {},
  })

  await assert.rejects(
    runtime.replace(databaseFiber, {
      name: 'invalid-replacement',
      provides: [
        [database, {}],
        [logger, {}],
      ],
      setup() {},
    }),
    /logger.*already provided/,
  )

  assert.equal(databaseFiber.state, 'active')
  assert.equal(databaseDisposals, 0)
  assert.notEqual(runtime.get(database), undefined)
})

test('repeated removal is idempotent and does not recover effects twice', async () => {
  const runtime = new Runtime()
  let disposals = 0
  const fiber = await runtime.add({
    name: 'standalone',
    async setup(context) {
      await context.effect(() => () => {
        disposals += 1
      })
    },
  })

  await runtime.remove(fiber)
  await runtime.remove(fiber)

  assert.equal(disposals, 1)
  assert.equal(fiber.state, 'disposed')
})
