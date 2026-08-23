import assert from 'node:assert/strict'
import test from 'node:test'

import { Realm, Runtime, service } from '../src/runtime.ts'

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

test('isolated sibling realms resolve the same key to local providers', async () => {
  const model = service<{ id: string }>('model')
  const runtime = new Runtime()
  const agentA = runtime.root.derive({ isolate: [model] })
  const agentB = runtime.root.derive({ isolate: [model] })
  const seen: string[] = []

  const consumerA = runtime.add({
    name: 'consumer-a',
    realm: agentA,
    requires: [model],
    setup(context) { seen.push(`a:${context.get(model).id}`) },
  })
  const consumerB = runtime.add({
    name: 'consumer-b',
    realm: agentB,
    requires: [model],
    setup(context) { seen.push(`b:${context.get(model).id}`) },
  })
  runtime.add({
    name: 'model-a',
    realm: agentA,
    provides: [[model, { id: 'A' }]],
    setup() {},
  })
  runtime.add({
    name: 'model-b',
    realm: agentB,
    provides: [[model, { id: 'B' }]],
    setup() {},
  })

  await runtime.settle()

  assert.deepEqual(seen.sort(), ['a:A', 'b:B'])
  assert.equal(consumerA.state, 'active')
  assert.equal(consumerB.state, 'active')
  assert.equal(runtime.get(model, agentA)?.id, 'A')
  assert.equal(runtime.get(model, agentB)?.id, 'B')
})

test('duplicate providers are rejected per effective provider slot', async () => {
  const storage = service<object>('storage')
  const runtime = new Runtime()
  const realmA = runtime.root.derive({ isolate: [storage] })
  const nestedA = realmA.derive()
  const realmB = runtime.root.derive({ isolate: [storage] })

  runtime.add({
    name: 'storage-a',
    realm: realmA,
    provides: [[storage, {}]],
    setup() {},
  })

  assert.throws(
    () => runtime.add({
      name: 'nested-storage-a',
      realm: nestedA,
      provides: [[storage, {}]],
      setup() {},
    }),
    /already provided by component "storage-a"/,
  )

  const providerB = runtime.add({
    name: 'storage-b',
    realm: realmB,
    provides: [[storage, {}]],
    setup() {},
  })
  await runtime.settle()
  assert.equal(providerB.state, 'active')
})

test('ordinary keys inherit from root while isolation blocks ancestor fallback', async () => {
  const configuration = service<{ source: string }>('configuration')
  const runtime = new Runtime()
  const inherited = runtime.root.derive()
  const isolated = runtime.root.derive({ isolate: [configuration] })
  const trace: string[] = []

  runtime.add({
    name: 'root-config',
    provides: [[configuration, { source: 'root' }]],
    setup() {},
  })
  const inheritedConsumer = runtime.add({
    name: 'inherited-consumer',
    realm: inherited,
    requires: [configuration],
    setup(context) { trace.push(`inherited:${context.get(configuration).source}`) },
  })
  const isolatedConsumer = runtime.add({
    name: 'isolated-consumer',
    realm: isolated,
    requires: [configuration],
    setup(context) { trace.push(`isolated:${context.get(configuration).source}`) },
  })
  await runtime.settle()

  assert.equal(inheritedConsumer.state, 'active')
  assert.equal(isolatedConsumer.state, 'pending')
  assert.deepEqual(trace, ['inherited:root'])
  assert.equal(runtime.get(configuration, isolated), undefined)

  runtime.add({
    name: 'isolated-config',
    realm: isolated,
    provides: [[configuration, { source: 'local' }]],
    setup() {},
  })
  await runtime.settle()
  assert.equal(isolatedConsumer.state, 'active')
  assert.deepEqual(trace, ['inherited:root', 'isolated:local'])
})

test('replacement in one isolated realm leaves its sibling active', async () => {
  const model = service<{ id: string }>('model')
  const runtime = new Runtime()
  const realmA = runtime.root.derive({ isolate: [model] })
  const realmB = runtime.root.derive({ isolate: [model] })
  const activationsA: string[] = []
  const activationsB: string[] = []
  let cleanupsA = 0
  let cleanupsB = 0

  const providerA = runtime.add({
    name: 'model-a1',
    realm: realmA,
    provides: [[model, { id: 'a1' }]],
    async setup(context) {
      await context.effect(() => () => { cleanupsA += 1 })
    },
  })
  runtime.add({
    name: 'model-b1',
    realm: realmB,
    provides: [[model, { id: 'b1' }]],
    async setup(context) {
      await context.effect(() => () => { cleanupsB += 1 })
    },
  })
  const consumerA = runtime.add({
    name: 'consumer-a',
    realm: realmA,
    requires: [model],
    async setup(context) {
      activationsA.push(context.get(model).id)
      await context.effect(() => () => { cleanupsA += 1 })
    },
  })
  const consumerB = runtime.add({
    name: 'consumer-b',
    realm: realmB,
    requires: [model],
    async setup(context) {
      activationsB.push(context.get(model).id)
      await context.effect(() => () => { cleanupsB += 1 })
    },
  })
  await runtime.settle()

  runtime.replace(providerA, {
    name: 'model-a2',
    realm: realmA,
    provides: [[model, { id: 'a2' }]],
    setup() {},
  })
  await runtime.settle()

  assert.deepEqual(activationsA, ['a1', 'a2'])
  assert.deepEqual(activationsB, ['b1'])
  assert.equal(cleanupsA, 2)
  assert.equal(cleanupsB, 0)
  assert.equal(consumerA.state, 'active')
  assert.equal(consumerB.state, 'active')
})

test('interceptors run root-to-leaf and update without reactivation', async () => {
  const greeting = service<string>('greeting')
  const runtime = new Runtime()
  const child = runtime.root.derive()
  const trace: string[] = []
  let activations = 0
  let read!: () => string

  runtime.add({
    name: 'greeting',
    provides: [[greeting, 'hello']],
    setup() {},
  })
  const rootPolicy = runtime.root.intercept(greeting, ({ value }) => {
    trace.push('root')
    return `${value}:root`
  })
  const childPolicy = child.intercept(greeting, ({ value }) => {
    trace.push('child')
    return `${value}:child`
  })
  const consumer = runtime.add({
    name: 'consumer',
    realm: child,
    requires: [greeting],
    setup(context) {
      activations += 1
      read = () => context.get(greeting)
    },
  })
  await runtime.settle()

  assert.equal(read(), 'hello:root:child')
  assert.deepEqual(trace, ['root', 'child'])

  trace.length = 0
  childPolicy.update(({ value }) => {
    trace.push('child-updated')
    return `${value}:updated`
  })
  assert.equal(read(), 'hello:root:updated')
  assert.deepEqual(trace, ['root', 'child-updated'])
  assert.equal(activations, 1)
  assert.equal(consumer.state, 'active')

  rootPolicy.dispose()
  rootPolicy.dispose()
  trace.length = 0
  assert.equal(read(), 'hello:updated')
  assert.deepEqual(trace, ['child-updated'])
  assert.equal(activations, 1)
})

test('requester-aware denial does not change dependency satisfaction', async () => {
  const secrets = service<{ token: string }>('secrets')
  const rawSecrets = { token: 'host-visible' }
  const runtime = new Runtime()
  const realm = runtime.root.derive()
  let allowedRead!: () => string
  let deniedRead!: () => string

  runtime.add({
    name: 'secrets',
    provides: [[secrets, rawSecrets]],
    setup() {},
  })
  realm.intercept(secrets, ({ value, consumer }) => {
    if (consumer.name === 'denied') {
      throw new Error(`component ${consumer.name} may not access secrets`)
    }
    return value
  })
  const allowed = runtime.add({
    name: 'allowed',
    realm,
    requires: [secrets],
    setup(context) { allowedRead = () => context.get(secrets).token },
  })
  const denied = runtime.add({
    name: 'denied',
    realm,
    requires: [secrets],
    setup(context) { deniedRead = () => context.get(secrets).token },
  })
  await runtime.settle()

  assert.equal(allowedRead(), 'host-visible')
  assert.throws(deniedRead, /component denied may not access secrets/)
  assert.equal(allowed.state, 'active')
  assert.equal(denied.state, 'active')
  assert.equal(runtime.get(secrets, realm), rawSecrets)

  // Context mediation is not a sandbox: host-language references bypass it.
  assert.equal(rawSecrets.token, 'host-visible')
})

test('context rejects access to a service the component did not declare', async () => {
  const clock = service<object>('clock')
  const runtime = new Runtime()

  runtime.add({
    name: 'clock',
    provides: [[clock, {}]],
    setup() {},
  })
  const undeclared = runtime.add({
    name: 'undeclared-consumer',
    setup(context) {
      context.get(clock)
    },
  })

  await assert.rejects(
    runtime.settle(),
    /did not declare and commit service "clock"/,
  )
  assert.equal(undeclared.state, 'pending')
  assert.notEqual(runtime.get(clock), undefined)
})

test('provider replacement during isolated setup cannot publish stale services', async () => {
  const model = service<{ id: string }>('model')
  const runtime = new Runtime()
  const realm = runtime.root.derive({ isolate: [model] })
  const sibling = runtime.root.derive({ isolate: [model] })
  const started = deferred()
  const finish = deferred()
  const trace: string[] = []

  const consumer = runtime.add({
    name: 'consumer',
    realm,
    requires: [model],
    setup(context) { trace.push(`consumer:${context.get(model).id}`) },
  })
  const first = runtime.add({
    name: 'model-v1',
    realm,
    provides: [[model, { id: 'v1' }]],
    async setup(context) {
      await context.effect(() => {
        trace.push('v1:acquire')
        return () => { trace.push('v1:recover') }
      })
      started.resolve()
      await finish.promise
    },
  })
  const siblingProvider = runtime.add({
    name: 'sibling-model',
    realm: sibling,
    provides: [[model, { id: 'sibling' }]],
    setup() { trace.push('sibling:active') },
  })

  await started.promise
  const second = runtime.replace(first, {
    name: 'model-v2',
    realm,
    provides: [[model, { id: 'v2' }]],
    setup() { trace.push('v2:active') },
  })
  finish.resolve()
  await runtime.settle()

  assert.deepEqual(trace, [
    'v1:acquire',
    'sibling:active',
    'v1:recover',
    'v2:active',
    'consumer:v2',
  ])
  assert.equal(first.state, 'disposed')
  assert.equal(second.state, 'active')
  assert.equal(consumer.state, 'active')
  assert.equal(siblingProvider.state, 'active')
  assert.equal(runtime.get(model, sibling)?.id, 'sibling')
})

test('a realm from another runtime is rejected', () => {
  const first = new Runtime()
  const second = new Runtime()
  const foreign = first.root.derive()

  assert.throws(
    () => second.add({ name: 'foreign', realm: foreign, setup() {} }),
    /realm does not belong to this runtime/,
  )
  assert.throws(
    () => new Realm(second, first.root),
    /realms must be created by a runtime or derived realm/,
  )
})
