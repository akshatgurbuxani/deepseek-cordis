import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EmptySystemPrompt,
  HARNESS_IDENTITY_SECTION,
  InMemorySystemPrompt,
  type PromptAssemblyContext,
  type PromptSection,
} from '@deepseek-cordis/system-prompt'

const baseContext: PromptAssemblyContext = {
  sessionId: 'session-a',
  turnId: 'session-a:turn:1',
  step: 2,
  tools: [{ name: 'read', description: 'Read', inputSchema: {} }],
}

test('assembly is ordered, immutable, dynamic, and drops empty sections', async () => {
  const prompts = new InMemorySystemPrompt()
  const seen: PromptAssemblyContext[] = []
  prompts.register({ name: 'z-last-tie', order: 10, text: '  Z  ' })
  prompts.register({ name: 'a-first-tie', order: 10, text: async (context) => {
    seen.push(context)
    return `step ${context.step}; tools ${context.tools.map(({ name }) => name).join(', ')}`
  } })
  prompts.register({ name: 'empty', order: 0, text: '  ' })
  prompts.register(HARNESS_IDENTITY_SECTION)

  const assembly = await prompts.assemble(baseContext)

  assert.deepEqual(assembly, {
    systemPrompt: [
      'You are an AI coding agent powered by DeepSeek Cordis Harness.',
      'step 2; tools read',
      'Z',
    ].join('\n\n'),
    sectionNames: ['harness:identity', 'a-first-tie', 'z-last-tie'],
  })
  assert.equal(seen.length, 1)
  assert.notEqual(seen[0], baseContext)
  assert.deepEqual(seen[0], baseContext)
  assert.equal(Object.isFrozen(seen[0]), true)
  assert.equal(Object.isFrozen(seen[0]?.tools), true)
  assert.equal(Object.isFrozen(assembly), true)
  assert.equal(Object.isFrozen(assembly.sectionNames), true)
})

test('session-scoped names shadow globals and exact disposers restore them', async () => {
  const prompts = new InMemorySystemPrompt()
  prompts.register({ name: 'persona', order: 0, text: 'global' })
  const disposeScoped = prompts.register(
    { name: 'persona', order: 0, text: 'scoped' },
    { scope: 'session-a' },
  )
  prompts.register({ name: 'only-a', order: 1, text: 'only scoped' }, { scope: 'session-a' })

  assert.equal((await prompts.assemble(baseContext)).systemPrompt, 'scoped\n\nonly scoped')
  assert.equal((await prompts.assemble({ ...baseContext, sessionId: 'session-b' })).systemPrompt, 'global')
  assert.throws(
    () => prompts.register({ name: 'persona', order: 2, text: 'duplicate' }),
    /already registered in global scope/,
  )
  assert.throws(
    () => prompts.register({ name: 'persona', order: 2, text: 'duplicate' }, { scope: 'session-a' }),
    /already registered in scope "session-a"/,
  )

  disposeScoped()
  disposeScoped()
  assert.equal((await prompts.assemble(baseContext)).systemPrompt, 'global\n\nonly scoped')
  const replacement = prompts.register(
    { name: 'persona', order: 0, text: 'replacement' },
    { scope: 'session-a' },
  )
  assert.match((await prompts.assemble(baseContext)).systemPrompt ?? '', /^replacement/)
  replacement()
})

test('registration and provider failures are loud and cancellation is control flow', async () => {
  const prompts = new InMemorySystemPrompt()
  const mutable: PromptSection = { name: 'stable', order: 1, text: 'original' }
  prompts.register(mutable)
  ;(mutable as { name: string }).name = 'changed'
  assert.deepEqual((await prompts.assemble(baseContext)).sectionNames, ['stable'])

  assert.throws(() => prompts.register({ name: ' ', order: 0, text: '' }), /must not be empty/)
  assert.throws(() => prompts.register({ name: 'bad-order', order: Infinity, text: '' }), /must be finite/)
  assert.throws(
    () => prompts.register({ name: 'bad-text', order: 0, text: 1 } as unknown as PromptSection),
    /text is invalid/,
  )
  assert.throws(
    () => prompts.register({ name: 'scope', order: 0, text: '' }, { scope: ' ' }),
    /scope must not be empty/,
  )

  const invalid = new InMemorySystemPrompt()
  invalid.register({
    name: 'invalid-provider', order: 0,
    text: (() => 42) as unknown as PromptSection['text'],
  })
  await assert.rejects(invalid.assemble(baseContext), /returned non-string text/)

  const controller = new AbortController()
  const cancelled = new InMemorySystemPrompt()
  cancelled.register({ name: 'cancel', order: 0, text: async () => {
    controller.abort(new Error('cancel prompt'))
    return 'not published'
  } })
  await assert.rejects(
    cancelled.assemble({ ...baseContext, signal: controller.signal }),
    /cancel prompt/,
  )

  const alreadyCancelled = new AbortController()
  alreadyCancelled.abort(new Error('already cancelled'))
  await assert.rejects(
    new EmptySystemPrompt().assemble({ ...baseContext, signal: alreadyCancelled.signal }),
    /already cancelled/,
  )
  assert.throws(
    () => new EmptySystemPrompt().register({ name: 'x', order: 0, text: 'x' }),
    /does not accept registrations/,
  )
  assert.deepEqual(await new EmptySystemPrompt().assemble(baseContext), { sectionNames: [] })
})
