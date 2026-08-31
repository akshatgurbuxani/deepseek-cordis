import { Context } from 'cordis'

import {
  createAgentLoopPlugin,
  createModelPlugin,
  createSessionPlugin,
  createToolPlugin,
  createToolRegistryPlugin,
  type JsonValue,
  mountPlugin,
  ReplayModelAdapter,
} from './index.ts'
import { OpenRouterModelAdapter } from './openrouter.ts'
import {
  consoleTrace,
  TracingModelAdapter,
  TracingSessionStore,
  traceCordisLifecycle,
} from './tracing.ts'

const argumentsList = process.argv.slice(2)
const replay = argumentsList[0] === '--replay'
if (replay) argumentsList.shift()
const input = argumentsList.join(' ') || 'Use the add tool to calculate 17 + 25.'

const context = new Context()
const stopLifecycleTrace = traceCordisLifecycle(context)
const mounted = []

function calculator(argumentsValue: JsonValue): number {
  if (
    argumentsValue === null ||
    Array.isArray(argumentsValue) ||
    typeof argumentsValue !== 'object' ||
    typeof argumentsValue.a !== 'number' ||
    typeof argumentsValue.b !== 'number'
  )
    throw new Error('calculator expects numeric a and b arguments')
  return argumentsValue.a + argumentsValue.b
}

try {
  const sessions = createSessionPlugin(new TracingSessionStore())
  const tools = createToolRegistryPlugin()
  const innerModel = replay
    ? new ReplayModelAdapter('visible-replay', [
        {
          type: 'tool_calls',
          calls: [{ id: 'replay-call-1', name: 'add', arguments: { a: 17, b: 25 } }],
        },
        { type: 'message', content: 'The answer is 42.' },
      ])
    : new OpenRouterModelAdapter({
        apiKey: process.env.OPENROUTER_API_KEY ?? '',
        model: process.env.OPENROUTER_MODEL ?? 'openrouter/free',
        appTitle: 'deepseek-cordis Spike 007',
        onUsage: (usage) => consoleTrace('openrouter/usage', usage),
      })
  const model = createModelPlugin(new TracingModelAdapter(innerModel))
  const loop = createAgentLoopPlugin()

  mounted.push(await mountPlugin(context, sessions.plugin))
  mounted.push(await mountPlugin(context, tools.plugin))
  mounted.push(
    await mountPlugin(
      context,
      createToolPlugin({
        name: 'add',
        description: 'Add two numbers. Always use this tool when the user asks for addition.',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' },
          },
          required: ['a', 'b'],
          additionalProperties: false,
        },
        execute: calculator,
      }),
    ),
  )
  mounted.push(await mountPlugin(context, model.plugin))
  mounted.push(await mountPlugin(context, loop.plugin))

  consoleTrace('demo/start', {
    mode: replay ? 'replay' : 'openrouter',
    model: replay ? innerModel.id : (process.env.OPENROUTER_MODEL ?? 'openrouter/free'),
    input,
  })
  const session = context.sessions.create(`demo-${Date.now()}`)
  const result = await context.agentLoop.run(session, input)
  consoleTrace('demo/result', result)
} catch (error) {
  console.error('\n[demo/error]')
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  for (const item of mounted.reverse()) await item.fiber.dispose()
  stopLifecycleTrace()
}
