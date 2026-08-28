import { AppBoot, type ManifestEntry } from '@deepseek-cordis/app-boot'
import type { ModelAdapter } from '@deepseek-cordis/model'
import { ReplayModelAdapter } from '@deepseek-cordis/model/testing'
import { OpenRouterModelAdapter } from '@deepseek-cordis/model-openrouter'
import type { JsonValue, RunResult } from '@deepseek-cordis/protocol'
import {
  createAgentLoopPlugin,
  createModelAdapterPlugin,
  createSessionStorePlugin,
  createToolRegistrationPlugin,
  createToolRegistryPlugin,
} from '@deepseek-cordis/runtime-cordis'

import {
  consoleTrace,
  type TraceSink,
  traceRuntimeLifecycle,
  TracingModelAdapter,
  TracingSessionStore,
} from './tracing.js'

const defaultInput = 'Use the add tool to calculate 17 + 25.'

export interface CliConfiguration {
  readonly mode: 'replay' | 'openrouter'
  readonly input: string
  readonly model: string
}

export interface RunCliOptions {
  readonly argv?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly fetch?: typeof globalThis.fetch
  readonly trace?: TraceSink
  readonly output?: (content: string) => void
  readonly sessionId?: string
}

export function parseCliArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CliConfiguration {
  let replay = false
  const inputParts: string[] = []
  for (const argument of argv) {
    if (argument === '--replay') {
      replay = true
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown option ${JSON.stringify(argument)}`)
    } else {
      inputParts.push(argument)
    }
  }
  return {
    mode: replay ? 'replay' : 'openrouter',
    input: inputParts.join(' ') || defaultInput,
    model: replay ? 'replay/calculator' : env.OPENROUTER_MODEL ?? 'openrouter/free',
  }
}

function replayModel(input: string): ReplayModelAdapter {
  const operands = input.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
  const left = operands[0]
  const right = operands[1]
  if (left === undefined || right === undefined) {
    throw new Error('replay mode expects the input to contain at least two numbers')
  }
  const answer = left + right
  return new ReplayModelAdapter('calculator', [
    {
      type: 'tool_calls',
      calls: [{ id: 'replay-add-1', name: 'add', arguments: { a: left, b: right } }],
    },
    { type: 'message', content: `The answer is ${answer}.` },
  ])
}

function calculator(argumentsValue: JsonValue): number {
  if (
    argumentsValue === null
    || Array.isArray(argumentsValue)
    || typeof argumentsValue !== 'object'
    || typeof argumentsValue.a !== 'number'
    || typeof argumentsValue.b !== 'number'
    || !Number.isFinite(argumentsValue.a)
    || !Number.isFinite(argumentsValue.b)
  ) throw new Error('calculator expects finite numeric a and b arguments')
  return argumentsValue.a + argumentsValue.b
}

function manifestFor(
  sessions: ReturnType<typeof createSessionStorePlugin>,
  model: ModelAdapter,
): readonly ManifestEntry[] {
  const tools = createToolRegistryPlugin()
  const modelPlugin = createModelAdapterPlugin(model)
  const loop = createAgentLoopPlugin()
  return [
    { id: 'loop', revision: 'v1', load: () => loop.plugin },
    { id: 'add', revision: 'v1', load: () => createToolRegistrationPlugin({
      name: 'add',
      description: 'Add two numbers. Use this tool for arithmetic addition.',
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
    }) },
    { id: 'sessions', revision: 'v1', load: () => sessions.plugin },
    { id: 'tools', revision: 'v1', load: () => tools.plugin },
    { id: 'model', revision: 'v1', load: () => modelPlugin.plugin },
  ]
}

export async function runCli(options: RunCliOptions = {}): Promise<RunResult> {
  const argv = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const trace = options.trace ?? consoleTrace
  const output = options.output ?? console.log
  const configuration = parseCliArguments(argv, env)
  const boot = new AppBoot()
  const stopLifecycleTrace = traceRuntimeLifecycle(boot.context, trace)

  try {
    const innerModel = configuration.mode === 'replay'
      ? replayModel(configuration.input)
      : new OpenRouterModelAdapter({
          apiKey: env.OPENROUTER_API_KEY ?? '',
          model: configuration.model,
          ...(env.OPENROUTER_HTTP_REFERER
            ? { httpReferer: env.OPENROUTER_HTTP_REFERER }
            : {}),
          ...(env.OPENROUTER_APP_TITLE
            ? { appTitle: env.OPENROUTER_APP_TITLE }
            : env.OPENROUTER_HTTP_REFERER
              ? { appTitle: 'deepseek-cordis' }
              : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
          onDiagnostics: (diagnostics) => trace('openrouter/diagnostics', diagnostics),
        })
    const sessions = createSessionStorePlugin(new TracingSessionStore(trace))
    const model = new TracingModelAdapter(innerModel, trace)

    trace('cli/start', configuration)
    await boot.reconcile(manifestFor(sessions, model))
    const session = boot.context.sessions.create(options.sessionId ?? `cli-${Date.now()}`)
    const result = await boot.context.agentLoop.run(session, configuration.input)
    trace('cli/result', result)
    output(result.content)
    return result
  } finally {
    await boot.dispose()
    stopLifecycleTrace()
  }
}
