import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { AgentLoop } from '@deepseek-cordis/agent-loop'
import { AppBoot, type ManifestEntry } from '@deepseek-cordis/app-boot'
import {
  type ApprovalService,
  DenyApprovalService,
  UnavailableApprovalService,
} from '@deepseek-cordis/approval'
import { createCompactCommand, createInspectCommand } from '@deepseek-cordis/command-session'
import { InMemoryCommandRegistry } from '@deepseek-cordis/commands'
import {
  ModelSummaryAdapter,
  SessionCompactor,
  type SummaryAdapter,
} from '@deepseek-cordis/compaction'
import {
  DEFAULT_HARNESS_PROFILE,
  type HarnessProfile,
  type HarnessToolId,
  parseHarnessProfile,
} from '@deepseek-cordis/configuration'
import { ContextBudgetPolicy } from '@deepseek-cordis/context-budget'
import {
  createWorkspaceFilesystemTools,
  NodeWorkspaceFileSystem,
  WORKSPACE_EDIT_FILE_TOOL,
  WORKSPACE_FILESYSTEM_PROMPT_SECTION,
  WORKSPACE_LIST_DIRECTORY_TOOL,
  WORKSPACE_READ_FILE_TOOL,
  WORKSPACE_STAT_PATH_TOOL,
  WORKSPACE_WRITE_FILE_TOOL,
  WorkspaceFilesystemSandbox,
} from '@deepseek-cordis/filesystem-workspace'
import type { ModelAdapter } from '@deepseek-cordis/model'
import { ReplayModelAdapter } from '@deepseek-cordis/model/testing'
import { OpenRouterModelAdapter } from '@deepseek-cordis/model-openrouter'
import type { JsonValue, RunResult } from '@deepseek-cordis/protocol'
import {
  createAgentLoopPlugin,
  createApprovalServicePlugin,
  createCommandRegistrationPlugin,
  createCommandRegistryPlugin,
  createCompactionPlugin,
  createModelAdapterPlugin,
  createPromptSectionPlugin,
  createSandboxPlugin,
  createSessionStorePlugin,
  createSystemPromptPlugin,
  createTokenMeterPlugin,
  createToolRegistrationPlugin,
  createToolRegistryPlugin,
} from '@deepseek-cordis/runtime-cordis'
import { type ToolSandbox, UnavailableToolSandbox } from '@deepseek-cordis/sandbox'
import {
  createWorkspaceFileTool,
  WORKSPACE_CREATE_FILE_TOOL,
} from '@deepseek-cordis/sandbox-workspace'
import { InMemorySessionStore, type SessionStore } from '@deepseek-cordis/session'
import { FileSessionStore } from '@deepseek-cordis/session-file'
import { HARNESS_IDENTITY_SECTION } from '@deepseek-cordis/system-prompt'
import { TokenMeter } from '@deepseek-cordis/token-meter'

import {
  type ApprovalPrompt,
  InteractiveApprovalService,
  InteractiveReplayModelAdapter,
} from './interactive.js'

import {
  consoleTrace,
  type TraceSink,
  TracingModelAdapter,
  TracingSessionStore,
  traceRuntimeLifecycle,
} from './tracing.js'

const defaultInput = 'Use the add tool to calculate 17 + 25.'

export interface CliConfiguration {
  readonly mode: 'replay' | 'openrouter'
  readonly interactive: boolean
  readonly input: string
  readonly model: string
  readonly profilePath?: string
}

export interface ResolvedCliConfiguration extends CliConfiguration {
  readonly profile: HarnessProfile
  readonly profilePath?: string
  readonly workspaceRoot: string
  readonly sessionDirectory?: string
  readonly contextWindow?: number
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
  let profilePath = env.HARNESS_PROFILE
  let commandLineProfile = false
  const inputParts: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--replay') {
      replay = true
    } else if (argument === '--interactive') {
      interactive = true
    } else if (argument === '--profile') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
        throw new Error('--profile requires a path')
      }
      if (commandLineProfile) throw new Error('--profile may be specified only once')
      profilePath = value
      commandLineProfile = true
      index += 1
    } else if (argument.startsWith('--profile=')) {
      const value = argument.slice('--profile='.length)
      if (value.trim().length === 0) throw new Error('--profile requires a path')
      if (commandLineProfile) throw new Error('--profile may be specified only once')
      profilePath = value
      commandLineProfile = true
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown option ${JSON.stringify(argument)}`)
    } else {
      inputParts.push(argument)
    }
  }
  if (profilePath !== undefined && profilePath.trim().length === 0) {
    throw new Error('HARNESS_PROFILE must be a non-empty path')
  }
  return {
    mode: replay ? 'replay' : 'openrouter',
    interactive,
    input: inputParts.join(' ') || defaultInput,
    model: replay ? 'replay/calculator' : (env.OPENROUTER_MODEL ?? 'openrouter/free'),
    ...(profilePath === undefined ? {} : { profilePath }),
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

function launchPath(value: string, baseDirectory: string): string {
  return resolve(baseDirectory, value)
}

/** Load and compose one profile below explicit CLI/environment launch overlays. */
export function resolveCliConfiguration(
  parsed: CliConfiguration,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedCliConfiguration {
  const absoluteProfilePath =
    parsed.profilePath === undefined ? undefined : resolve(parsed.profilePath)
  const profile =
    absoluteProfilePath === undefined
      ? DEFAULT_HARNESS_PROFILE
      : parseHarnessProfile(readFileSync(absoluteProfilePath, 'utf8'), absoluteProfilePath)
  const profileBase =
    absoluteProfilePath === undefined ? process.cwd() : dirname(absoluteProfilePath)
  const replay = parsed.mode === 'replay' || profile.model.provider === 'replay'
  const model = replay
    ? 'replay/calculator'
    : (env.OPENROUTER_MODEL ??
      (profile.model.provider === 'openrouter' ? profile.model.id : 'openrouter/free'))
  const environmentContextWindow = optionalPositiveInteger(
    env.HARNESS_CONTEXT_WINDOW ?? env.OPENROUTER_CONTEXT_WINDOW,
    'HARNESS_CONTEXT_WINDOW',
  )
  const sessionDirectory = env.HARNESS_SESSION_DIR
    ? launchPath(env.HARNESS_SESSION_DIR, process.cwd())
    : profile.persistence.kind === 'file'
      ? launchPath(profile.persistence.directory, profileBase)
      : undefined
  const workspaceRoot = env.HARNESS_WORKSPACE_ROOT
    ? launchPath(env.HARNESS_WORKSPACE_ROOT, process.cwd())
    : launchPath(profile.workspace.root, profileBase)
  return {
    ...parsed,
    mode: replay ? 'replay' : 'openrouter',
    model,
    profile,
    ...(absoluteProfilePath === undefined ? {} : { profilePath: absoluteProfilePath }),
    workspaceRoot,
    ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    ...(environmentContextWindow === undefined && profile.model.contextWindow === undefined
      ? {}
      : { contextWindow: environmentContextWindow ?? profile.model.contextWindow }),
  }
}

function replayModel(input: string, contextWindow?: number): ReplayModelAdapter {
  const operands = input.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
  const left = operands[0]
  const right = operands[1]
  if (left === undefined || right === undefined) {
    throw new Error('replay mode expects the input to contain at least two numbers')
  }
  const answer = left + right
  return new ReplayModelAdapter(
    'calculator',
    [
      {
        type: 'tool_calls',
        calls: [{ id: 'replay-add-1', name: 'add', arguments: { a: left, b: right } }],
      },
      { type: 'message', content: `The answer is ${answer}.` },
    ],
    contextWindow === undefined ? {} : { contextWindow },
  )
}

function calculator(argumentsValue: JsonValue): number {
  if (
    argumentsValue === null ||
    Array.isArray(argumentsValue) ||
    typeof argumentsValue !== 'object' ||
    typeof argumentsValue.a !== 'number' ||
    typeof argumentsValue.b !== 'number' ||
    !Number.isFinite(argumentsValue.a) ||
    !Number.isFinite(argumentsValue.b)
  )
    throw new Error('calculator expects finite numeric a and b arguments')
  return argumentsValue.a + argumentsValue.b
}

const workspaceToolIds = new Map<string, HarnessToolId>([
  [WORKSPACE_CREATE_FILE_TOOL, 'workspace.create'],
  [WORKSPACE_READ_FILE_TOOL, 'workspace.read'],
  [WORKSPACE_LIST_DIRECTORY_TOOL, 'workspace.list'],
  [WORKSPACE_STAT_PATH_TOOL, 'workspace.stat'],
  [WORKSPACE_WRITE_FILE_TOOL, 'workspace.write'],
  [WORKSPACE_EDIT_FILE_TOOL, 'workspace.edit'],
])

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
    ...(env.OPENROUTER_HTTP_REFERER ? { httpReferer: env.OPENROUTER_HTTP_REFERER } : {}),
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
  profile: HarnessProfile,
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
  const systemPrompt = createSystemPromptPlugin()
  const filesystemTools = createWorkspaceFilesystemTools()
  const enabledTools = new Set(profile.tools.enabled)
  const personaSection = Object.freeze({
    name: 'profile:persona',
    order: -500,
    text: profile.prompt.persona ?? '',
  })
  return [
    { id: 'loop', revision: 'v1', load: () => loop.plugin },
    {
      id: 'add',
      revision: 'v1',
      enabled: enabledTools.has('add'),
      load: () =>
        createToolRegistrationPlugin({
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
        }),
    },
    {
      id: 'create-workspace-file',
      revision: 'v1',
      enabled: enabledTools.has('workspace.create'),
      load: () => createToolRegistrationPlugin(createWorkspaceFileTool()),
    },
    ...filesystemTools.map((definition) => ({
      id: definition.name,
      revision: 'v1',
      enabled: enabledTools.has(workspaceToolIds.get(definition.name)!),
      load: () => createToolRegistrationPlugin(definition),
    })),
    { id: 'sessions', revision: 'v1', load: () => sessions.plugin },
    { id: 'tools', revision: 'v1', load: () => tools.plugin },
    { id: 'model', revision: 'v1', load: () => modelPlugin.plugin },
    { id: 'approval', revision: 'v1', load: () => createApprovalServicePlugin(approval).plugin },
    { id: 'sandbox', revision: 'v1', load: () => createSandboxPlugin(sandbox).plugin },
    { id: 'system-prompt', revision: 'v1', load: () => systemPrompt.plugin },
    {
      id: 'prompt-identity',
      revision: 'v1',
      enabled: profile.prompt.identity,
      load: () => createPromptSectionPlugin(HARNESS_IDENTITY_SECTION),
    },
    {
      id: 'prompt-persona',
      revision: 'v1',
      enabled: profile.prompt.persona !== undefined,
      load: () => createPromptSectionPlugin(personaSection),
    },
    {
      id: 'prompt-workspace-filesystem',
      revision: 'v1',
      enabled: profile.prompt.workspaceGuidance,
      load: () => createPromptSectionPlugin(WORKSPACE_FILESYSTEM_PROMPT_SECTION),
    },
    { id: 'compaction', revision: 'v1', load: () => compaction.plugin },
    { id: 'token-meter', revision: 'v1', load: () => tokenMeter.plugin },
    { id: 'commands', revision: 'v1', load: () => commands.plugin },
    {
      id: 'command-inspect',
      revision: 'v1',
      load: () => createCommandRegistrationPlugin(createInspectCommand()),
    },
    {
      id: 'command-compact',
      revision: 'v1',
      load: () => createCommandRegistrationPlugin(createCompactCommand(compactor)),
    },
    {
      id: 'command-help',
      revision: 'v1',
      load: () =>
        createCommandRegistrationPlugin({
          name: 'help',
          description: 'List available commands',
          handler: () => ({
            kind: 'success',
            text: commands.value
              .list()
              .map(
                (command) =>
                  `/${command.name}${command.inputHint ? ` ${command.inputHint}` : ''} — ${command.description}`,
              )
              .join('\n'),
          }),
        }),
    },
    {
      id: 'command-exit',
      revision: 'v1',
      load: () =>
        createCommandRegistrationPlugin({
          name: 'exit',
          description: 'Exit the interactive session',
          handler: () => ({ kind: 'success', text: 'Session closed.' }),
        }),
    },
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
  configuration: ResolvedCliConfiguration,
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
    const workspaceEnabled = configuration.profile.tools.enabled.some((id) =>
      id.startsWith('workspace.'),
    )
    const sandbox: ToolSandbox = workspaceEnabled
      ? new WorkspaceFilesystemSandbox({
          filesystem: new NodeWorkspaceFileSystem({
            root: configuration.workspaceRoot,
            maxFileBytes: configuration.profile.workspace.maxFileBytes,
          }),
        })
      : new UnavailableToolSandbox()
    const sessionStore: SessionStore = configuration.sessionDirectory
      ? new FileSessionStore({ directory: configuration.sessionDirectory })
      : new InMemorySessionStore()
    const tracedSessions = new TracingSessionStore(trace, sessionStore)
    const sessions = createSessionStorePlugin(tracedSessions)
    const model = new TracingModelAdapter(innerModel, trace)
    const compactor = new SessionCompactor(createSummary(model))
    const meter = new TokenMeter()
    const policy = new ContextBudgetPolicy({
      compactor,
      meter,
      thresholdRatio: configuration.profile.context.thresholdRatio,
      retainTurns: configuration.profile.context.retainTurns,
      maxOverflowRetries: configuration.profile.context.maxOverflowRetries,
    })
    const sessionId = options.sessionId ?? env.HARNESS_SESSION_ID ?? `cli-${Date.now()}`
    const existingSession = tracedSessions.get(sessionId)

    trace('cli/start', {
      mode: configuration.mode,
      interactive: configuration.interactive,
      input: configuration.input,
      model: configuration.model,
      profile: configuration.profile.name,
      profileSource: configuration.profilePath === undefined ? 'default' : 'file',
      tools: configuration.profile.tools.enabled,
      approvalDefault: configuration.profile.approval.default,
      sessionId,
      sessionStore: configuration.sessionDirectory ? 'file' : 'memory',
      resumed: existingSession !== undefined,
    })
    await boot.reconcile(
      manifestFor(
        configuration.profile,
        sessions,
        model,
        compactor,
        meter,
        policy,
        approval,
        sandbox,
      ),
    )
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
  const parsed = parseCliArguments(argv, env)
  if (parsed.interactive) {
    throw new Error('--interactive must be run through the interactive CLI adapter')
  }
  const configuration = resolveCliConfiguration(parsed, env)

  let runtime: MountedCliRuntime | undefined
  try {
    const innerModel =
      configuration.mode === 'replay'
        ? replayModel(configuration.input, configuration.contextWindow)
        : openRouterModel(configuration, env, options, trace, configuration.contextWindow)
    runtime = await mountCliRuntime(
      configuration,
      options,
      innerModel,
      (model) =>
        new ModelSummaryAdapter(
          configuration.mode === 'replay'
            ? new TracingModelAdapter(
                new ReplayModelAdapter('summary', [
                  { type: 'message', content: 'Earlier conversation compacted for replay.' },
                ]),
                trace,
              )
            : model,
        ),
      configuration.profile.approval.default === 'deny'
        ? new DenyApprovalService()
        : new UnavailableApprovalService(),
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
  const configuration = resolveCliConfiguration({ ...parsed, interactive: true }, env)
  const innerModel =
    configuration.mode === 'replay'
      ? new InteractiveReplayModelAdapter(configuration.contextWindow)
      : openRouterModel(configuration, env, options, trace, configuration.contextWindow)
  const promptApproval: ApprovalPrompt =
    options.approve ??
    (async (request) => {
      const answer = await options.readLine(
        `[approval] ${request.toolName} (${request.risk}): ${request.reason}\n` +
          `Arguments: ${JSON.stringify(request.arguments)}\nAllow once? [y/N] `,
      )
      if (answer === undefined) return undefined
      return /^(?:y|yes)$/i.test(answer.trim())
    })
  const approval =
    configuration.profile.approval.default === 'ask'
      ? new InteractiveApprovalService(promptApproval)
      : new DenyApprovalService()
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
