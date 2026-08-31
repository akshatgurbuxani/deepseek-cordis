import { AppBoot, type ManifestEntry } from '@deepseek-cordis/app-boot'
import { AgentLoop } from '@deepseek-cordis/agent-loop'
import { UnavailableApprovalService, type ApprovalService } from '@deepseek-cordis/approval'
import {
  createCompactCommand,
  createInspectCommand,
} from '@deepseek-cordis/command-session'
import { InMemoryCommandRegistry } from '@deepseek-cordis/commands'
import {
  ModelSummaryAdapter,
  SessionCompactor,
  type SummaryAdapter,
} from '@deepseek-cordis/compaction'
import { ContextBudgetPolicy } from '@deepseek-cordis/context-budget'
import {
  createWorkspaceFilesystemTools,
  NodeWorkspaceFileSystem,
  WorkspaceFilesystemSandbox,
} from '@deepseek-cordis/filesystem-workspace'
import type { ModelAdapter } from '@deepseek-cordis/model'
import { ReplayModelAdapter } from '@deepseek-cordis/model/testing'
import { OpenRouterModelAdapter } from '@deepseek-cordis/model-openrouter'
import type { JsonValue, RunResult } from '@deepseek-cordis/protocol'
import { InMemorySessionStore, type SessionStore } from '@deepseek-cordis/session'
import { FileSessionStore } from '@deepseek-cordis/session-file'
import type { ToolSandbox } from '@deepseek-cordis/sandbox'
import { TokenMeter } from '@deepseek-cordis/token-meter'
import {
  createWorkspaceFileTool,
} from '@deepseek-cordis/sandbox-workspace'
import {
  createAgentLoopPlugin,
  createApprovalServicePlugin,
  createCompactionPlugin,
  createCommandRegistrationPlugin,
  createCommandRegistryPlugin,
  createModelAdapterPlugin,
  createSessionStorePlugin,
  createSandboxPlugin,
  createToolRegistrationPlugin,
  createToolRegistryPlugin,
  createTokenMeterPlugin,
} from '@deepseek-cordis/runtime-cordis'

import {
  type ApprovalPrompt,
  InteractiveApprovalService,
  InteractiveReplayModelAdapter,
} from './interactive.js'

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
  readonly interactive: boolean
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
  let interactive = false
  const inputParts: string[] = []
  for (const argument of argv) {
    if (argument === '--replay') {
      replay = true
    } else if (argument === '--interactive') {
      interactive = true
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown option ${JSON.stringify(argument)}`)
    } else {
      inputParts.push(argument)
    }
  }
  return {
    mode: replay ? 'replay' : 'openrouter',
    interactive,
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

function openRouterModel(
  configuration: CliConfiguration,
  env: Readonly<Record<string, string | undefined>>,
  options: RunCliOptions,
  trace: TraceSink,
  contextWindow: number | undefined,
): OpenRouterModelAdapter {
  return new OpenRouterModelAdapter({
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
}

function manifestFor(
  sessions: ReturnType<typeof createSessionStorePlugin>,
  model: ModelAdapter,
  compactor: SessionCompactor,
  meter: TokenMeter,
  policy: ContextBudgetPolicy,
  approval: ApprovalService,
  sandbox: ToolSandbox,
): readonly ManifestEntry[] {
  const tools = createToolRegistryPlugin()
  const commands = createCommandRegistryPlugin(new InMemoryCommandRegistry())
  const modelPlugin = createModelAdapterPlugin(model)
  const loop = createAgentLoopPlugin(new AgentLoop(policy))
  const compaction = createCompactionPlugin(compactor)
  const tokenMeter = createTokenMeterPlugin(meter)
  const filesystemTools = createWorkspaceFilesystemTools()
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
      safety: { risk: 'none' },
      execute: calculator,
    }) },
    { id: 'create-workspace-file', revision: 'v1', load: () =>
      createToolRegistrationPlugin(createWorkspaceFileTool()) },
    ...filesystemTools.map((definition) => ({
      id: definition.name,
      revision: 'v1',
      load: () => createToolRegistrationPlugin(definition),
    })),
    { id: 'sessions', revision: 'v1', load: () => sessions.plugin },
    { id: 'tools', revision: 'v1', load: () => tools.plugin },
    { id: 'model', revision: 'v1', load: () => modelPlugin.plugin },
    { id: 'approval', revision: 'v1', load: () => createApprovalServicePlugin(approval).plugin },
    { id: 'sandbox', revision: 'v1', load: () => createSandboxPlugin(sandbox).plugin },
    { id: 'compaction', revision: 'v1', load: () => compaction.plugin },
    { id: 'token-meter', revision: 'v1', load: () => tokenMeter.plugin },
    { id: 'commands', revision: 'v1', load: () => commands.plugin },
    { id: 'command-inspect', revision: 'v1', load: () =>
      createCommandRegistrationPlugin(createInspectCommand()) },
    { id: 'command-compact', revision: 'v1', load: () =>
      createCommandRegistrationPlugin(createCompactCommand(compactor)) },
    { id: 'command-help', revision: 'v1', load: () => createCommandRegistrationPlugin({
      name: 'help',
      description: 'List available commands',
      handler: () => ({
        kind: 'success',
        text: commands.value.list().map((command) =>
          `/${command.name}${command.inputHint ? ` ${command.inputHint}` : ''} — ${command.description}`
        ).join('\n'),
      }),
    }) },
    { id: 'command-exit', revision: 'v1', load: () => createCommandRegistrationPlugin({
      name: 'exit', description: 'Exit the interactive session',
      handler: () => ({ kind: 'success', text: 'Session closed.' }),
    }) },
  ]
}

interface MountedCliRuntime {
  readonly boot: AppBoot
  readonly session: ReturnType<SessionStore['create']>
  readonly model: ModelAdapter
  readonly compactor: SessionCompactor
  close(): Promise<void>
}

async function mountCliRuntime(
  configuration: CliConfiguration,
  options: RunCliOptions,
  innerModel: ModelAdapter,
  createSummary: (model: ModelAdapter) => SummaryAdapter,
  approval: ApprovalService = new UnavailableApprovalService(),
): Promise<MountedCliRuntime> {
  const env = options.env ?? process.env
  const trace = options.trace ?? consoleTrace
  const boot = new AppBoot()
  const stopLifecycleTrace = traceRuntimeLifecycle(boot.context, trace)
  try {
    const filesystem = new NodeWorkspaceFileSystem({
      root: env.HARNESS_WORKSPACE_ROOT ?? process.cwd(),
    })
    const sandbox = new WorkspaceFilesystemSandbox({ filesystem })
    const sessionStore: SessionStore = env.HARNESS_SESSION_DIR
      ? new FileSessionStore({ directory: env.HARNESS_SESSION_DIR })
      : new InMemorySessionStore()
    const tracedSessions = new TracingSessionStore(trace, sessionStore)
    const sessions = createSessionStorePlugin(tracedSessions)
    const model = new TracingModelAdapter(innerModel, trace)
    const compactor = new SessionCompactor(createSummary(model))
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
    await boot.reconcile(manifestFor(
      sessions,
      model,
      compactor,
      meter,
      policy,
      approval,
      sandbox,
    ))
    const session = existingSession ?? boot.context.sessions.create(sessionId)
    return {
      boot,
      session,
      model,
      compactor,
      async close() {
        await boot.dispose()
        stopLifecycleTrace()
      },
    }
  } catch (error) {
    await boot.dispose()
    stopLifecycleTrace()
    throw error
  }
}

export async function runCli(options: RunCliOptions = {}): Promise<RunResult> {
  const argv = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const trace = options.trace ?? consoleTrace
  const output = options.output ?? console.log
  const configuration = parseCliArguments(argv, env)
  if (configuration.interactive) {
    throw new Error('--interactive must be run through the interactive CLI adapter')
  }

  let runtime: MountedCliRuntime | undefined
  try {
    const contextWindow = optionalPositiveInteger(
      env.HARNESS_CONTEXT_WINDOW ?? env.OPENROUTER_CONTEXT_WINDOW,
      'HARNESS_CONTEXT_WINDOW',
    )
    const innerModel = configuration.mode === 'replay'
      ? replayModel(configuration.input, contextWindow)
      : openRouterModel(configuration, env, options, trace, contextWindow)
    runtime = await mountCliRuntime(
      configuration,
      options,
      innerModel,
      (model) => new ModelSummaryAdapter(configuration.mode === 'replay'
        ? new TracingModelAdapter(new ReplayModelAdapter('summary', [
            { type: 'message', content: 'Earlier conversation compacted for replay.' },
          ]), trace)
        : model),
    )
    const result = await runtime.boot.context.agentLoop.run(runtime.session, configuration.input, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
    })
    trace('cli/result', result)
    output(result.content)
    return result
  } finally {
    await runtime?.close()
  }
}

export interface InteractiveCliOptions extends RunCliOptions {
  readonly readLine: (prompt: string) => string | undefined | Promise<string | undefined>
  readonly approve?: ApprovalPrompt
}

export interface InteractiveCliResult {
  readonly sessionId: string
  readonly turns: number
  readonly commands: number
}

export async function runInteractiveCli(
  options: InteractiveCliOptions,
): Promise<InteractiveCliResult> {
  const argv = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const trace = options.trace ?? consoleTrace
  const output = options.output ?? console.log
  const parsed = parseCliArguments(argv, env)
  const configuration = { ...parsed, interactive: true }
  const contextWindow = optionalPositiveInteger(
    env.HARNESS_CONTEXT_WINDOW ?? env.OPENROUTER_CONTEXT_WINDOW,
    'HARNESS_CONTEXT_WINDOW',
  )
  const innerModel = configuration.mode === 'replay'
    ? new InteractiveReplayModelAdapter(contextWindow)
    : openRouterModel(configuration, env, options, trace, contextWindow)
  const promptApproval: ApprovalPrompt = options.approve ?? (async (request) => {
    const answer = await options.readLine(
      `[approval] ${request.toolName} (${request.risk}): ${request.reason}\n`
        + `Arguments: ${JSON.stringify(request.arguments)}\nAllow once? [y/N] `,
    )
    if (answer === undefined) return undefined
    return /^(?:y|yes)$/i.test(answer.trim())
  })
  const approval = new InteractiveApprovalService(promptApproval)
  let runtime: MountedCliRuntime | undefined
  try {
    runtime = await mountCliRuntime(
      configuration,
      options,
      innerModel,
      configuration.mode === 'replay'
        ? () => ({
            id: 'replay:interactive-summary',
            summarize: async () => 'Earlier conversation compacted for replay.',
          })
        : (model) => new ModelSummaryAdapter(model),
      approval,
    )
    while (!options.signal?.aborted) {
      const line = await options.readLine('> ')
      if (line === undefined) break
      if (line.trim().length === 0) continue
      if (line.startsWith('/')) {
        const execution = await runtime.boot.context.commands.execute(
          runtime.session,
          line,
          options.signal ? { signal: options.signal } : {},
        )
        if (!execution) {
          output(`Unknown command. Use /help to list available commands.`)
          continue
        }
        if (execution.result.text !== undefined) output(execution.result.text)
        if (execution.name === 'exit' && execution.result.kind === 'success') break
        continue
      }
      const result = await runtime.boot.context.agentLoop.run(runtime.session, line, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
      })
      trace('cli/result', result)
      output(result.content)
    }
    return {
      sessionId: runtime.session.id,
      turns: runtime.session.events.filter((event) => event.type === 'turn/start').length,
      commands: runtime.session.events.filter((event) => event.type === 'command/run').length,
    }
  } finally {
    await runtime?.close()
  }
}

export {
  type ApprovalPresentation,
  type ApprovalPrompt,
  InteractiveApprovalService,
  InteractiveReplayModelAdapter,
} from './interactive.js'
