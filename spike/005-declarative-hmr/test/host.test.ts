import assert from 'node:assert/strict'
import test from 'node:test'

import { DeclarativeHost, type ManifestEntry, service } from '../src/index.ts'

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

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap(errorMessages)]
  }
  return error instanceof Error ? [error.message] : [String(error)]
}

test('configuration order does not affect activation and identical rereads are no-ops', async () => {
  const database = service<{ id: string }>('database')
  const host = new DeclarativeHost()
  let providerLoads = 0
  let consumerLoads = 0
  let activations = 0

  const manifest: ManifestEntry[] = [
    {
      id: 'repository',
      revision: 'v1',
      load() {
        consumerLoads += 1
        return {
          name: 'repository',
          requires: [database],
          setup(context) {
            assert.equal(context.get(database).id, 'primary')
            activations += 1
          },
        }
      },
    },
    {
      id: 'database',
      revision: 'v1',
      load() {
        providerLoads += 1
        return {
          name: 'database',
          provides: [[database, { id: 'primary' }]],
          setup() {},
        }
      },
    },
  ]

  const first = await host.reconcile(manifest)
  const repositoryHandle = host.entry('repository')!
  const repositoryFiber = repositoryHandle.fiber

  const second = await host.reconcile(manifest.map((entry) => ({ ...entry })))

  assert.deepEqual([...first.added].sort(), ['database', 'repository'])
  assert.deepEqual([...second.preserved].sort(), ['database', 'repository'])
  assert.deepEqual(second.added, [])
  assert.deepEqual(second.updated, [])
  assert.equal(host.entry('repository'), repositoryHandle)
  assert.equal(host.entry('repository')?.fiber, repositoryFiber)
  assert.equal(providerLoads, 1)
  assert.equal(consumerLoads, 1)
  assert.equal(activations, 1)
})

test('disabling a parent drains its subtree and preserves an unrelated entry', async () => {
  const host = new DeclarativeHost()
  const trace: string[] = []

  const entry = (id: string, parentId?: string): ManifestEntry => ({
    id,
    ...(parentId === undefined ? {} : { parentId }),
    revision: 'v1',
    load: () => ({
      name: id,
      async setup(context) {
        trace.push(`${id}:activate`)
        await context.effect(() => () => {
          trace.push(`${id}:dispose`)
        })
      },
    }),
  })

  const initial = [entry('parent'), entry('child', 'parent'), entry('unrelated')]
  await host.reconcile(initial)
  const parentHandle = host.entry('parent')!
  const childHandle = host.entry('child')!
  const unrelatedFiber = host.entry('unrelated')?.fiber

  const disabled = initial.map((item) =>
    item.id === 'parent' ? { ...item, enabled: false } : item,
  )
  const result = await host.reconcile(disabled)

  assert.deepEqual(result.removed, ['child', 'parent'])
  assert.deepEqual(trace, [
    'parent:activate',
    'unrelated:activate',
    'child:activate',
    'child:dispose',
    'parent:dispose',
  ])
  assert.equal(parentHandle.fiber, undefined)
  assert.equal(childHandle.fiber, undefined)
  assert.equal(host.entry('unrelated')?.fiber, unrelatedFiber)

  await host.reconcile(initial)
  assert.equal(host.entry('parent'), parentHandle)
  assert.equal(host.entry('child'), childHandle)
  assert.equal(parentHandle.active, true)
  assert.equal(childHandle.active, true)
})

test('successful provider reload restarts only its dependency subgraph', async () => {
  const database = service<{ id: string }>('database')
  const host = new DeclarativeHost()
  const repositoryActivations: string[] = []
  let repositoryCleanups = 0
  let unrelatedActivations = 0
  let unrelatedCleanups = 0

  const repository: ManifestEntry = {
    id: 'repository',
    revision: 'v1',
    load: () => ({
      name: 'repository',
      requires: [database],
      async setup(context) {
        repositoryActivations.push(context.get(database).id)
        await context.effect(() => () => {
          repositoryCleanups += 1
        })
      },
    }),
  }
  const unrelated: ManifestEntry = {
    id: 'unrelated',
    revision: 'v1',
    load: () => ({
      name: 'unrelated',
      async setup(context) {
        unrelatedActivations += 1
        await context.effect(() => () => {
          unrelatedCleanups += 1
        })
      },
    }),
  }
  const databaseEntry = (revision: string): ManifestEntry => ({
    id: 'database',
    revision,
    load: () => ({
      name: `database-${revision}`,
      provides: [[database, { id: revision }]],
      setup() {},
    }),
  })

  await host.reconcile([databaseEntry('v1'), repository, unrelated])
  const repositoryFiber = host.entry('repository')?.fiber
  const unrelatedFiber = host.entry('unrelated')?.fiber

  const result = await host.reconcile([databaseEntry('v2'), repository, unrelated])

  assert.deepEqual(result.updated, ['database'])
  assert.deepEqual(repositoryActivations, ['v1', 'v2'])
  assert.equal(repositoryCleanups, 1)
  assert.equal(host.entry('repository')?.fiber, repositoryFiber)
  assert.equal(unrelatedActivations, 1)
  assert.equal(unrelatedCleanups, 0)
  assert.equal(host.entry('unrelated')?.fiber, unrelatedFiber)
  assert.equal(host.runtime.get(database)?.id, 'v2')
})

test('module load failure leaves the last-known-good graph untouched', async () => {
  const model = service<{ id: string }>('model')
  const host = new DeclarativeHost()
  let cleanups = 0

  await host.reconcile([
    {
      id: 'model',
      revision: 'v1',
      load: () => ({
        name: 'model-v1',
        provides: [[model, { id: 'v1' }]],
        async setup(context) {
          await context.effect(() => () => {
            cleanups += 1
          })
        },
      }),
    },
  ])
  const oldHandle = host.entry('model')!
  const oldFiber = oldHandle.fiber

  await assert.rejects(
    host.reconcile([
      {
        id: 'model',
        revision: 'v2',
        load() {
          throw new SyntaxError('invalid module syntax')
        },
      },
    ]),
    /invalid module syntax/,
  )

  assert.equal(host.entry('model'), oldHandle)
  assert.equal(oldHandle.fiber, oldFiber)
  assert.equal(oldHandle.revision, 'v1')
  assert.equal(oldFiber?.state, 'active')
  assert.equal(host.runtime.get(model)?.id, 'v1')
  assert.equal(cleanups, 0)
})

test('activation failure restores the last-known-good provider and consumers', async () => {
  const database = service<{ id: string }>('database')
  const host = new DeclarativeHost()
  const trace: string[] = []

  const databaseV1: ManifestEntry = {
    id: 'database',
    revision: 'v1',
    load: () => ({
      name: 'database-v1',
      provides: [[database, { id: 'v1' }]],
      async setup(context) {
        trace.push('database-v1:activate')
        await context.effect(() => () => {
          trace.push('database-v1:dispose')
        })
      },
    }),
  }
  const repository: ManifestEntry = {
    id: 'repository',
    revision: 'v1',
    load: () => ({
      name: 'repository',
      requires: [database],
      async setup(context) {
        const id = context.get(database).id
        trace.push(`repository:${id}:activate`)
        await context.effect(() => () => {
          trace.push(`repository:${id}:dispose`)
        })
      },
    }),
  }
  await host.reconcile([databaseV1, repository])
  const repositoryFiber = host.entry('repository')?.fiber

  const databaseV2: ManifestEntry = {
    id: 'database',
    revision: 'v2',
    load: () => ({
      name: 'database-v2',
      provides: [[database, { id: 'v2' }]],
      async setup(context) {
        trace.push('database-v2:activate')
        await context.effect(() => () => {
          trace.push('database-v2:rollback')
        })
        throw new Error('database-v2 activation failed')
      },
    }),
  }

  await assert.rejects(host.reconcile([databaseV2, repository]), /database-v2 activation failed/)

  assert.equal(host.entry('database')?.revision, 'v1')
  assert.equal(host.entry('database')?.fiber?.state, 'active')
  assert.equal(host.entry('repository')?.fiber, repositoryFiber)
  assert.equal(repositoryFiber?.state, 'active')
  assert.equal(host.runtime.get(database)?.id, 'v1')
  assert.deepEqual(trace, [
    'database-v1:activate',
    'repository:v1:activate',
    'repository:v1:dispose',
    'database-v1:dispose',
    'database-v2:activate',
    'database-v2:rollback',
    'database-v1:activate',
    'repository:v1:activate',
  ])
})

test('failed restoration retains both the change and rollback errors', async () => {
  const serviceKey = service<object>('service')
  const host = new DeclarativeHost()
  let oldAttempts = 0

  const oldEntry: ManifestEntry = {
    id: 'service',
    revision: 'v1',
    load: () => ({
      name: 'service-v1',
      provides: [[serviceKey, {}]],
      setup() {
        oldAttempts += 1
        if (oldAttempts > 1) throw new Error('restoring v1 failed')
      },
    }),
  }
  await host.reconcile([oldEntry])

  const error = await host
    .reconcile([
      {
        id: 'service',
        revision: 'v2',
        load: () => ({
          name: 'service-v2',
          provides: [[serviceKey, {}]],
          setup() {
            throw new Error('activating v2 failed')
          },
        }),
      },
    ])
    .then(
      () => undefined,
      (reason: unknown) => reason,
    )

  assert.ok(error instanceof AggregateError)
  assert.ok(errorMessages(error).includes('activating v2 failed'))
  assert.ok(errorMessages(error).includes('restoring v1 failed'))
  assert.equal(host.entry('service')?.revision, 'v1')
  assert.equal(host.entry('service')?.fiber?.state, 'pending')
})

test('isolated realm reload leaves the sibling realm unchanged', async () => {
  const model = service<{ id: string }>('model')
  const host = new DeclarativeHost()
  const realmA = host.runtime.root.derive({ isolate: [model] })
  const realmB = host.runtime.root.derive({ isolate: [model] })
  const seenA: string[] = []
  const seenB: string[] = []

  const modelEntry = (id: string, realm: typeof realmA): ManifestEntry => ({
    id: `model-${id[0]}`,
    revision: id,
    load: () => ({
      name: `model-${id}`,
      realm,
      provides: [[model, { id }]],
      setup() {},
    }),
  })
  const consumerA: ManifestEntry = {
    id: 'consumer-a',
    revision: 'v1',
    load: () => ({
      name: 'consumer-a',
      realm: realmA,
      requires: [model],
      setup(context) {
        seenA.push(context.get(model).id)
      },
    }),
  }
  const consumerB: ManifestEntry = {
    id: 'consumer-b',
    revision: 'v1',
    load: () => ({
      name: 'consumer-b',
      realm: realmB,
      requires: [model],
      setup(context) {
        seenB.push(context.get(model).id)
      },
    }),
  }

  await host.reconcile([modelEntry('a1', realmA), modelEntry('b1', realmB), consumerA, consumerB])
  const siblingFiber = host.entry('consumer-b')?.fiber

  await host.reconcile([modelEntry('a2', realmA), modelEntry('b1', realmB), consumerA, consumerB])

  assert.deepEqual(seenA, ['a1', 'a2'])
  assert.deepEqual(seenB, ['b1'])
  assert.equal(host.entry('consumer-b')?.fiber, siblingFiber)
})

test('manifest validation rejects duplicate, missing-parent, and cyclic entries', async () => {
  const host = new DeclarativeHost()
  const load = () => ({ name: 'component', setup() {} })

  await assert.rejects(
    host.reconcile([
      { id: 'same', revision: '1', load },
      { id: 'same', revision: '2', load },
    ]),
    /duplicate entry "same"/,
  )
  await assert.rejects(
    host.reconcile([{ id: 'child', parentId: 'missing', revision: '1', load }]),
    /missing parent "missing"/,
  )
  await assert.rejects(
    host.reconcile([
      { id: 'a', parentId: 'b', revision: '1', load },
      { id: 'b', parentId: 'a', revision: '1', load },
    ]),
    /parent cycle/,
  )
  assert.deepEqual(host.entries, [])
})

test('queued manifests finish at the newest desired configuration', async () => {
  const version = service<string>('version')
  const firstLoad = deferred()
  const host = new DeclarativeHost()

  const first = host.reconcile([
    {
      id: 'version',
      revision: 'v1',
      async load() {
        await firstLoad.promise
        return {
          name: 'version-v1',
          provides: [[version, 'v1']],
          setup() {},
        }
      },
    },
  ])
  const second = host.reconcile([
    {
      id: 'version',
      revision: 'v2',
      load: () => ({
        name: 'version-v2',
        provides: [[version, 'v2']],
        setup() {},
      }),
    },
  ])

  firstLoad.resolve()
  await Promise.all([first, second])

  assert.equal(host.entry('version')?.revision, 'v2')
  assert.equal(host.runtime.get(version), 'v2')
})
