import { AppBoot, type ManifestEntry } from '@deepseek-cordis/app-boot'
import { AgentLoop } from '@deepseek-cordis/agent-loop'
import { ModelSummaryAdapter, SessionCompactor } from '@deepseek-cordis/compaction'
import { ContextBudgetPolicy } from '@deepseek-cordis/context-budget'
import type { ModelAdapter } from '@deepseek-cordis/model'
import { ReplayModelAdapter } from '@deepseek-cordis/model/testing'
import { OpenRouterModelAdapter } from '@deepseek-cordis/model-openrouter'
import type { JsonValue, RunResult } from '@deepseek-cordis/protocol'
import { InMemorySessionStore, type SessionStore } from '@deepseek-cordis/session'
import { FileSessionStore } from '@deepseek-cordis/session-file'
import { TokenMeter } from '@deepseek-cordis/token-meter'
import {
  createAgentLoopPlugin,
  createCompactionPlugin,
  createModelAdapterPlugin,
  createSessionStorePlugin,
  createToolRegistrationPlugin,
  createToolRegistryPlugin,
  createTokenMeterPlugin,
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
  readonly signal?: AbortSignal
  readonly onTextDelta?: (delta: string) => void
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

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function replayModel(input: string, contextWindow?: number): ReplayModelAdapter {
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
  ], contextWindow === undefined ? {} : { contextWindow })
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
  compactor: SessionCompactor,
  meter: TokenMeter,
  policy: ContextBudgetPolicy,
): readonly ManifestEntry[] {
  const tools = createToolRegistryPlugin()
  const modelPlugin = createModelAdapterPlugin(model)
  const loop = createAgentLoopPlugin(new AgentLoop(policy))
  const compaction = createCompactionPlugin(compactor)
  const tokenMeter = createTokenMeterPlugin(meter)
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
    { id: 'compaction', revision: 'v1', load: () => compaction.plugin },
    { id: 'token-meter', revision: 'v1', load: () => tokenMeter.plugin },
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
    const contextWindow = optionalPositiveInteger(
      env.HARNESS_CONTEXT_WINDOW ?? env.OPENROUTER_CONTEXT_WINDOW,
      'HARNESS_CONTEXT_WINDOW',
    )
    const innerModel = configuration.mode === 'replay'
      ? replayModel(configuration.input, contextWindow)
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
          ...(contextWindow === undefined ? {} : { contextWindow }),
        })
    const sessionStore: SessionStore = env.HARNESS_SESSION_DIR
      ? new FileSessionStore({ directory: env.HARNESS_SESSION_DIR })
      : new InMemorySessionStore()
    const tracedSessions = new TracingSessionStore(trace, sessionStore)
    const sessions = createSessionStorePlugin(tracedSessions)
    const model = new TracingModelAdapter(innerModel, trace)
    const summaryModel = configuration.mode === 'replay'
      ? new TracingModelAdapter(new ReplayModelAdapter('summary', [
          { type: 'message', content: 'Earlier conversation compacted for replay.' },
        ]), trace)
      : model
    const compactor = new SessionCompactor(new ModelSummaryAdapter(summaryModel))
    const meter = new TokenMeter()
    const policy = new ContextBudgetPolicy({ compactor, meter })
    const sessionId = options.sessionId ?? env.HARNESS_SESSION_ID ?? `cli-${Date.now()}`
    const existingSession = tracedSessions.get(sessionId)

    trace('cli/start', {
      ...configuration,
      sessionId,
      sessionStore: env.HARNESS_SESSION_DIR ? 'file' : 'memory',
      resumed: existingSession !== undefined,
    })
    await boot.reconcile(manifestFor(sessions, model, compactor, meter, policy))
    const session = existingSession ?? boot.context.sessions.create(sessionId)
    const result = await boot.context.agentLoop.run(session, configuration.input, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
    })
    trace('cli/result', result)
    output(result.content)
    return result
  } finally {
    await boot.dispose()
    stopLifecycleTrace()
  }
}
