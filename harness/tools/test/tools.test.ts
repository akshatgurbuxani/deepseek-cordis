import assert from 'node:assert/strict'
import test from 'node:test'
import type { ApprovalService } from '@deepseek-cordis/approval'
import type { JsonValue } from '@deepseek-cordis/protocol'
import type { ToolSandbox } from '@deepseek-cordis/sandbox'
import {
  InMemoryToolRegistry,
  type ToolDefinition,
  type ToolSafetyAuditEvent,
} from '@deepseek-cordis/tools'

function echoDefinition(name = 'echo'): ToolDefinition {
  return {
    name,
    description: 'Echo input',
    inputSchema: { type: 'object' },
    safety: { risk: 'none' },
    execute: (value) => value,
  }
}

function writeDefinition(): ToolDefinition {
  return {
    name: 'write-file',
    description: 'Write a file',
    inputSchema: { type: 'object' },
    safety: {
      risk: 'filesystem',
      approvalReason: 'write the requested workspace file',
      sandbox: { profile: 'workspace-write', requiredEnforcement: 'full' },
    },
  }
}

const callContext = { sessionId: 'session-1', turnId: 'turn-1', callId: 'call-1' }

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

  assert.deepEqual(schemas, [
    {
      name: 'echo',
      description: 'Echo input',
      inputSchema: { type: 'object' },
    },
  ])
  assert.equal(Object.isFrozen(schemas[0]), true)
  assert.equal(Object.isFrozen(schemas[0]?.inputSchema), true)
})

test('execution isolates arguments and successful output', async () => {
  const registry = new InMemoryToolRegistry()
  const input: { nested: { value: number } } = { nested: { value: 1 } }
  let received: JsonValue | undefined
  let receivedOptions: unknown
  registry.register({
    name: 'capture',
    description: 'Capture input',
    inputSchema: {},
    safety: { risk: 'none' },
    execute(value, options) {
      received = value
      receivedOptions = options
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
  assert.deepEqual(receivedOptions, {})
})

test('missing and throwing tools return explicit failures', async () => {
  const registry = new InMemoryToolRegistry()
  registry.register({
    name: 'boom',
    description: 'Throw an error',
    inputSchema: {},
    safety: { risk: 'none' },
    execute() {
      throw new Error('boom failed')
    },
  })
  registry.register({
    name: 'string-throw',
    description: 'Throw a string',
    inputSchema: {},
    safety: { risk: 'none' },
    execute() {
      throw 'string failed'
    },
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
    safety: { risk: 'none' },
    async execute(_value, { signal }) {
      receivedSignal = signal
      controller.abort({ kind: 'user' })
      return 'must not publish'
    },
  })

  await assert.rejects(registry.execute('cancel', null, { signal: controller.signal }))
  assert.equal(receivedSignal, controller.signal)
})

test('consequential definitions require complete safety declarations', () => {
  const registry = new InMemoryToolRegistry()
  assert.throws(
    () =>
      registry.register({
        name: 'bad-reason',
        description: 'Bad reason',
        inputSchema: {},
        safety: {
          risk: 'filesystem',
          approvalReason: ' ',
          sandbox: { profile: 'workspace-write', requiredEnforcement: 'full' },
        },
      }),
    /empty approval reason/,
  )
  assert.throws(
    () =>
      registry.register({
        name: 'bad-profile',
        description: 'Bad profile',
        inputSchema: {},
        safety: {
          risk: 'filesystem',
          approvalReason: 'write a file',
          sandbox: { profile: '', requiredEnforcement: 'full' },
        },
      }),
    /empty sandbox profile/,
  )
})

test('registration snapshots safety declarations against later mutation', async () => {
  const registry = new InMemoryToolRegistry()
  const definition = writeDefinition()
  registry.register(definition)
  ;(definition as unknown as { safety: { risk: string }; execute: () => string }).safety.risk =
    'none'
  ;(definition as unknown as { execute: () => string }).execute = () => 'bypassed'

  assert.deepEqual(await registry.execute('write-file', null), {
    ok: false,
    error: 'consequential tool execution requires call context',
  })
})

test('consequential execution fails closed before a sandbox can run', async () => {
  const registry = new InMemoryToolRegistry()
  registry.register(writeDefinition())
  const audits: ToolSafetyAuditEvent[] = []
  let sandboxPrepared = 0
  const sandbox: ToolSandbox = {
    async prepare() {
      sandboxPrepared += 1
      return { ok: false, reason: 'must not be reached' }
    },
  }

  assert.deepEqual(await registry.execute('write-file', { path: 'x' }), {
    ok: false,
    error: 'consequential tool execution requires call context',
  })
  assert.deepEqual(await registry.execute('write-file', null, { context: callContext }), {
    ok: false,
    error: 'approval service is unavailable',
  })
  assert.deepEqual(
    await registry.execute('write-file', null, {
      context: callContext,
      approval: { request: async () => 'rejected' },
    }),
    { ok: false, error: 'sandbox service is unavailable' },
  )
  assert.deepEqual(
    await registry.execute('write-file', null, {
      context: callContext,
      approval: { request: async () => 'allowed-once' },
      sandbox,
    }),
    { ok: false, error: 'safety audit sink is unavailable' },
  )

  for (const outcome of ['rejected', 'cancelled', 'unavailable'] as const) {
    const approval: ApprovalService = { request: async () => outcome }
    const execution = await registry.execute('write-file', null, {
      context: callContext,
      approval,
      sandbox,
      audit: (event) => audits.push(event),
    })
    assert.equal(execution.ok, false)
  }
  assert.equal(sandboxPrepared, 0)
  assert.deepEqual(
    audits.map((event) => event.type),
    [
      'approval/asked',
      'approval/decided',
      'approval/asked',
      'approval/decided',
      'approval/asked',
      'approval/decided',
    ],
  )
})

test('approval and full sandbox preflight precede provider-owned execution', async () => {
  const registry = new InMemoryToolRegistry()
  registry.register(writeDefinition())
  const order: string[] = []
  const audits: ToolSafetyAuditEvent[] = []
  let receivedArguments: JsonValue | undefined
  const input = { path: 'note.txt', content: { value: 1 } }
  const approval: ApprovalService = {
    async request(request) {
      order.push('approval')
      assert.deepEqual(
        { ...request, signal: undefined },
        {
          ...callContext,
          toolName: 'write-file',
          arguments: { path: 'note.txt', content: { value: 1 } },
          risk: 'filesystem',
          reason: 'write the requested workspace file',
          signal: undefined,
        },
      )
      return 'allowed-once'
    },
  }
  const sandbox: ToolSandbox = {
    async prepare(request) {
      order.push('sandbox-prepare')
      receivedArguments = request.arguments
      return {
        ok: true,
        lease: {
          provider: 'test/container-v1',
          enforcement: 'full',
          async execute() {
            order.push('sandbox-execute')
            return { written: request.arguments }
          },
          dispose() {
            order.push('sandbox-dispose')
          },
        },
      }
    },
  }

  const execution = await registry.execute('write-file', input, {
    context: callContext,
    approval,
    sandbox,
    audit(event) {
      order.push(event.type)
      audits.push(event)
    },
  })
  input.content.value = 2

  assert.deepEqual(order, [
    'approval/asked',
    'approval',
    'approval/decided',
    'sandbox-prepare',
    'sandbox/prepared',
    'sandbox-execute',
    'sandbox-dispose',
  ])
  assert.deepEqual(receivedArguments, { path: 'note.txt', content: { value: 1 } })
  assert.equal(receivedArguments !== undefined && Object.isFrozen(receivedArguments), true)
  assert.deepEqual(execution, {
    ok: true,
    output: { written: { path: 'note.txt', content: { value: 1 } } },
  })
  assert.deepEqual(audits.at(-1), {
    type: 'sandbox/prepared',
    callId: 'call-1',
    name: 'write-file',
    profile: 'workspace-write',
    provider: 'test/container-v1',
    enforcement: 'full',
  })
})

test('provider errors and insufficient enforcement cannot escape fail-closed policy', async () => {
  const registry = new InMemoryToolRegistry()
  registry.register(writeDefinition())
  const audits: ToolSafetyAuditEvent[] = []
  const throwingApproval: ApprovalService = {
    async request() {
      throw new Error('channel failed')
    },
  }
  assert.deepEqual(
    await registry.execute('write-file', null, {
      context: callContext,
      approval: throwingApproval,
      sandbox: { prepare: async () => ({ ok: false, reason: 'unused' }) },
      audit: (event) => audits.push(event),
    }),
    { ok: false, error: 'tool approval is unavailable' },
  )
  const decision = audits.at(-1)
  assert.equal(decision?.type, 'approval/decided')
  assert.equal(decision?.type === 'approval/decided' && decision.outcome, 'unavailable')

  assert.deepEqual(
    await registry.execute('write-file', null, {
      context: callContext,
      approval: { request: async () => 'invalid' as never },
      sandbox: { prepare: async () => ({ ok: false, reason: 'unused' }) },
      audit() {},
    }),
    { ok: false, error: 'tool approval is unavailable' },
  )

  const allowed = { request: async () => 'allowed-once' as const }
  assert.deepEqual(
    await registry.execute('write-file', null, {
      context: callContext,
      approval: allowed,
      sandbox: { prepare: async () => ({ ok: false, reason: 'profile unavailable' }) },
      audit() {},
    }),
    { ok: false, error: 'profile unavailable' },
  )
  assert.deepEqual(
    await registry.execute('write-file', null, {
      context: callContext,
      approval: allowed,
      sandbox: { prepare: async () => null as never },
      audit() {},
    }),
    { ok: false, error: 'sandbox provider returned an invalid preparation' },
  )
  assert.deepEqual(
    await registry.execute('write-file', null, {
      context: callContext,
      approval: allowed,
      sandbox: {
        prepare: async () => ({ ok: true, lease: { provider: '', enforcement: 'full' } }) as never,
      },
      audit() {},
    }),
    { ok: false, error: 'sandbox provider returned an invalid lease' },
  )

  let executed = false
  let disposed = false
  const partial: ToolSandbox = {
    async prepare() {
      return {
        ok: true,
        lease: {
          provider: 'partial-provider',
          enforcement: 'partial',
          async execute() {
            executed = true
            return null
          },
          dispose() {
            disposed = true
          },
        },
      }
    },
  }
  assert.deepEqual(
    await registry.execute('write-file', null, {
      context: callContext,
      approval: { request: async () => 'allowed-once' },
      sandbox: partial,
      audit() {},
    }),
    {
      ok: false,
      error: 'sandbox provider "partial-provider" reported partial enforcement',
    },
  )
  assert.equal(executed, false)
  assert.equal(disposed, true)
})

test('an audit commit failure prevents consequential execution', async () => {
  const registry = new InMemoryToolRegistry()
  registry.register(writeDefinition())
  let approvalRequests = 0
  let sandboxPreparations = 0
  const approval: ApprovalService = {
    async request() {
      approvalRequests += 1
      return 'allowed-once'
    },
  }
  const sandbox: ToolSandbox = {
    async prepare() {
      sandboxPreparations += 1
      return { ok: false, reason: 'unused' }
    },
  }
  const execution = await registry.execute('write-file', null, {
    context: callContext,
    approval,
    sandbox,
    audit() {
      throw new Error('audit storage failed')
    },
  })

  assert.deepEqual(execution, { ok: false, error: 'audit storage failed' })
  assert.equal(approvalRequests, 0)
  assert.equal(sandboxPreparations, 0)
})

test('cancellation after sandbox preflight disposes the unexecuted lease', async () => {
  const registry = new InMemoryToolRegistry()
  registry.register(writeDefinition())
  const controller = new AbortController()
  let executed = false
  let disposed = false
  const sandbox: ToolSandbox = {
    async prepare() {
      controller.abort({ kind: 'user' })
      return {
        ok: true,
        lease: {
          provider: 'cancelled-provider',
          enforcement: 'full',
          async execute() {
            executed = true
            return null
          },
          dispose() {
            disposed = true
          },
        },
      }
    },
  }

  await assert.rejects(
    registry.execute('write-file', null, {
      signal: controller.signal,
      context: callContext,
      approval: { request: async () => 'allowed-once' },
      sandbox,
      audit() {},
    }),
  )
  assert.equal(executed, false)
  assert.equal(disposed, true)
})
