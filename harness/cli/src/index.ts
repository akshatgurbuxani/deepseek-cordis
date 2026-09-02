import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { AgentLoop } from '@deepseek-cordis/agent-loop'
import { AppBoot, type ManifestEntry } from '@deepseek-cordis/app-boot'
import {
  type ApprovalService,
  DenyApprovalService,
  UnavailableApprovalService,
} from '@deepseek-cordis/approval'
import { createCompactCommand, createInspectCommand } from '@deepseek-cordis/command-session'
import { type CommandDefinition, InMemoryCommandRegistry } from '@deepseek-cordis/commands'
import {
  ModelSummaryAdapter,
  SessionCompactor,
  type SummaryAdapter,
} from '@deepseek-cordis/compaction'
import {
  DEFAULT_HARNESS_PROFILE,
  HARNESS_TOOL_IDS,
  type HarnessProfile,
  type HarnessToolId,
  parseHarnessProfile,
} from '@deepseek-cordis/configuration'
import { ContextBudgetPolicy } from '@deepseek-cordis/context-budget'
import {
  createWorkspaceFilesystemTools,
  NodeWorkspaceFileSystem,
  WORKSPACE_DELETE_FILE_TOOL,
  WORKSPACE_EDIT_FILE_TOOL,
  WORKSPACE_FILESYSTEM_PROFILE,
  WORKSPACE_FILESYSTEM_PROMPT_SECTION,
  WORKSPACE_FIND_PATHS_TOOL,
  WORKSPACE_LIST_DIRECTORY_TOOL,
  WORKSPACE_MOVE_FILE_TOOL,
  WORKSPACE_PATCH_FILE_TOOL,
  WORKSPACE_PREVIEW_PATCH_TOOL,
  WORKSPACE_READ_FILE_TOOL,
  WORKSPACE_STAT_PATH_TOOL,
  WORKSPACE_WRITE_FILE_TOOL,
  WorkspaceFilesystemSandbox,
} from '@deepseek-cordis/filesystem-workspace'
import type { ModelAdapter } from '@deepseek-cordis/model'
import { ReplayModelAdapter } from '@deepseek-cordis/model/testing'
import { OpenRouterModelAdapter } from '@deepseek-cordis/model-openrouter'
import {
  commandEnvironment,
  createWorkspaceCommandTool,
  DockerWorkspaceProcessRunner,
  NodeWorkspaceProcessRunner,
  WORKSPACE_COMMAND_PROFILE,
  WORKSPACE_COMMAND_PROMPT_SECTION,
  WORKSPACE_COMMAND_TOOL,
  WorkspaceCommandSandbox,
} from '@deepseek-cordis/process-workspace'
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
import {
  ProfiledToolSandbox,
  type ToolSandbox,
  UnavailableToolSandbox,
} from '@deepseek-cordis/sandbox'
import {
  createWorkspaceFileTool,
  WORKSPACE_CREATE_FILE_TOOL,
  WORKSPACE_WRITE_PROFILE,
} from '@deepseek-cordis/sandbox-workspace'
import { InMemorySessionStore, type SessionStore } from '@deepseek-cordis/session'
import { FileSessionStore, SessionWriteConflictError } from '@deepseek-cordis/session-file'
import { HARNESS_IDENTITY_SECTION } from '@deepseek-cordis/system-prompt'
import { TokenMeter } from '@deepseek-cordis/token-meter'
import {
  createWorkspaceInstructionsSection,
  NodeWorkspaceInstructions,
} from '@deepseek-cordis/workspace-instructions'

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
const cliHelp = `Usage: deepseek-cordis [options] [task]

Run options:
  --profile <path>    Load a validated harness profile
  --interactive       Keep one session open for multiple turns
  --resume <id>       Continue an existing persisted session
  --quiet             Suppress diagnostic traces
  --replay            Use the deterministic credential-free model

Administration:
  --init [path]       Create a non-overwriting coding profile
  --sessions          List sessions for file persistence
  --help, -h          Show this help`

export interface CliConfiguration {
  readonly mode: 'replay' | 'openrouter'
  readonly interactive: boolean
  readonly input: string
  readonly model: string
  readonly profilePath?: string
  readonly quiet: boolean
  readonly resumeSessionId?: string
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
  let quiet = false
  let resumeSessionId: string | undefined
  const inputParts: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--replay') {
      replay = true
    } else if (argument === '--interactive') {
      interactive = true
    } else if (argument === '--quiet') {
      quiet = true
    } else if (argument === '--resume') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
        throw new Error('--resume requires a session id')
      }
      if (resumeSessionId !== undefined) throw new Error('--resume may be specified only once')
      if (Buffer.byteLength(value, 'utf8') > 256) throw new Error('--resume session id is too long')
      resumeSessionId = value
      index += 1
    } else if (argument.startsWith('--resume=')) {
      const value = argument.slice('--resume='.length)
      if (value.trim().length === 0) throw new Error('--resume requires a session id')
      if (resumeSessionId !== undefined) throw new Error('--resume may be specified only once')
      if (Buffer.byteLength(value, 'utf8') > 256) throw new Error('--resume session id is too long')
      resumeSessionId = value
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
    quiet,
    input: inputParts.join(' ') || defaultInput,
    model: replay ? 'replay/calculator' : (env.OPENROUTER_MODEL ?? 'openrouter/free'),
    ...(profilePath === undefined ? {} : { profilePath }),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
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

export interface PersistedSessionSummary {
  readonly id: string
  readonly events: number
  readonly turns: number
  readonly lastStatus: 'completed' | 'failed' | 'aborted' | 'interrupted' | 'empty'
}

export function initializeCliProfile(path = 'deepseek-cordis.json'): string {
  const absolutePath = resolve(path)
  const profile = {
    ...DEFAULT_HARNESS_PROFILE,
    name: 'coding',
    persistence: { kind: 'file' as const, directory: '.deepseek-cordis/sessions' },
    tools: {
      enabled: HARNESS_TOOL_IDS.filter((tool) => tool !== 'add' && tool !== 'workspace.create'),
    },
  }
  try {
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `profile ${JSON.stringify(absolutePath)} already exists; it was not changed`,
        {
          cause: error,
        },
      )
    }
    throw error
  }
  return absolutePath
}

export function discoverPersistedSessions(
  configuration: ResolvedCliConfiguration,
): readonly PersistedSessionSummary[] {
  if (!configuration.sessionDirectory) {
    throw new Error('--sessions requires file persistence configured by the profile or environment')
  }
  return new FileSessionStore({ directory: configuration.sessionDirectory })
    .list()
    .map((session) => {
      const lastEnd = [...session.events].reverse().find((event) => event.type === 'turn/end')
      return {
        id: session.id,
        events: session.events.length,
        turns: session.events.filter((event) => event.type === 'turn/start').length,
        lastStatus: lastEnd?.type === 'turn/end' ? lastEnd.status : 'empty',
      }
    })
}

export interface CliOperatorOptions {
  readonly argv?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly output?: (content: string) => void
}

/** Handle model-free CLI administration. Returns false for an ordinary agent run. */
export function runCliOperator(options: CliOperatorOptions = {}): boolean {
  const argv = options.argv ?? process.argv.slice(2)
  const env = Object.freeze({ ...(options.env ?? process.env) })
  const output = options.output ?? console.log
  const initIndex = argv.findIndex(
    (argument) => argument === '--init' || argument.startsWith('--init='),
  )
  const sessionsIndex = argv.indexOf('--sessions')
  const helpIndex = argv.findIndex((argument) => argument === '--help' || argument === '-h')
  if (initIndex < 0 && sessionsIndex < 0 && helpIndex < 0) return false
  if (helpIndex >= 0) {
    if (argv.length !== 1) throw new Error('--help cannot be combined with other arguments')
    output(cliHelp)
    return true
  }
  if (initIndex >= 0 && sessionsIndex >= 0)
    throw new Error('--init and --sessions cannot be combined')

  if (initIndex >= 0) {
    if (initIndex !== 0) throw new Error('--init must be the first option')
    const argument = argv[0]!
    const inline = argument.startsWith('--init=') ? argument.slice('--init='.length) : undefined
    if (inline !== undefined && inline.trim().length === 0)
      throw new Error('--init requires a path')
    const path = inline ?? argv[1] ?? 'deepseek-cordis.json'
    if (path.startsWith('--')) throw new Error('--init requires a profile path after the option')
    const consumed = inline === undefined && argv[1] !== undefined ? 2 : 1
    if (argv.length !== consumed) throw new Error('--init accepts only one optional profile path')
    output(`Created ${initializeCliProfile(path)}`)
    return true
  }

  const remaining = argv.filter((_argument, index) => index !== sessionsIndex)
  for (let index = 0; index < remaining.length; index += 1) {
    const argument = remaining[index]!
    if (argument === '--quiet' || argument.startsWith('--profile=')) continue
    if (argument === '--profile') {
      index += 1
      continue
    }
    throw new Error('--sessions accepts only --profile and --quiet')
  }
  const parsed = parseCliArguments(remaining, env)
  if (
    parsed.interactive ||
    parsed.mode === 'replay' ||
    parsed.resumeSessionId !== undefined ||
    parsed.input !== defaultInput
  ) {
    throw new Error('--sessions accepts only --profile and --quiet')
  }
  const configuration = resolveCliConfiguration(parsed, env)
  const sessions = discoverPersistedSessions(configuration)
  if (sessions.length === 0) output('No persisted sessions.')
  for (const session of sessions) {
    output(
      `${session.id}\tturns=${session.turns}\tevents=${session.events}\tlast=${session.lastStatus}`,
    )
  }
  return true
}

/** Add a concrete recovery path to persistence conflicts shown by the executable. */
export function formatCliError(error: unknown): unknown {
  if (!(error instanceof SessionWriteConflictError)) return error
  const recovery =
    error.code === 'SESSION_WRITE_BUSY'
      ? 'Wait for the other writer to finish, then retry with --resume <session-id>.'
      : 'Use --sessions to inspect persisted sessions, then restart with --resume <session-id>.'
  return `${error.message}\n${recovery}`
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
  [WORKSPACE_FIND_PATHS_TOOL, 'workspace.find'],
  [WORKSPACE_STAT_PATH_TOOL, 'workspace.stat'],
  [WORKSPACE_WRITE_FILE_TOOL, 'workspace.write'],
  [WORKSPACE_EDIT_FILE_TOOL, 'workspace.edit'],
  [WORKSPACE_PREVIEW_PATCH_TOOL, 'workspace.preview_patch'],
  [WORKSPACE_PATCH_FILE_TOOL, 'workspace.patch'],
  [WORKSPACE_MOVE_FILE_TOOL, 'workspace.move'],
  [WORKSPACE_DELETE_FILE_TOOL, 'workspace.delete'],
  [WORKSPACE_COMMAND_TOOL, 'workspace.command'],
])

function openRouterModel(
  configuration: ResolvedCliConfiguration,
  env: Readonly<Record<string, string | undefined>>,
  options: RunCliOptions,
  trace: TraceSink,
  contextWindow: number | undefined,
): OpenRouterModelAdapter {
  if (configuration.profile.model.provider !== 'openrouter') {
    throw new Error('OpenRouter mode requires an OpenRouter model profile')
  }
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
    retry: configuration.profile.model.retry,
    routing: configuration.profile.model.routing,
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
  workspaceInstructions?: NodeWorkspaceInstructions,
  profileRevision = 'profile:1',
  reload?: CommandDefinition['handler'],
): readonly ManifestEntry[] {
  const tools = createToolRegistryPlugin()
  const commands = createCommandRegistryPlugin(new InMemoryCommandRegistry())
  const modelPlugin = createModelAdapterPlugin(model)
  const loop = createAgentLoopPlugin(new AgentLoop(policy))
  const compaction = createCompactionPlugin(compactor)
  const tokenMeter = createTokenMeterPlugin(meter)
  const systemPrompt = createSystemPromptPlugin()
  const filesystemTools = createWorkspaceFilesystemTools()
  const commandTool = createWorkspaceCommandTool(
    profile.process.backend === 'docker' ? 'full' : 'partial',
  )
  const enabledTools = new Set(profile.tools.enabled)
  const personaSection = Object.freeze({
    name: 'profile:persona',
    order: -500,
    text: profile.prompt.persona ?? '',
  })
  return [
    { id: 'loop', revision: profileRevision, load: () => loop.plugin },
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
    {
      id: WORKSPACE_COMMAND_TOOL,
      revision: profileRevision,
      enabled: enabledTools.has('workspace.command'),
      load: () => createToolRegistrationPlugin(commandTool),
    },
    { id: 'sessions', revision: 'v1', load: () => sessions.plugin },
    { id: 'tools', revision: 'v1', load: () => tools.plugin },
    { id: 'model', revision: profileRevision, load: () => modelPlugin.plugin },
    {
      id: 'approval',
      revision: profileRevision,
      load: () => createApprovalServicePlugin(approval).plugin,
    },
    {
      id: 'sandbox',
      revision: profileRevision,
      load: () => createSandboxPlugin(sandbox).plugin,
    },
    { id: 'system-prompt', revision: 'v1', load: () => systemPrompt.plugin },
    {
      id: 'prompt-identity',
      revision: 'v1',
      enabled: profile.prompt.identity,
      load: () => createPromptSectionPlugin(HARNESS_IDENTITY_SECTION),
    },
    {
      id: 'prompt-persona',
      revision: profileRevision,
      enabled: profile.prompt.persona !== undefined,
      load: () => createPromptSectionPlugin(personaSection),
    },
    {
      id: 'prompt-workspace-filesystem',
      revision: 'v1',
      enabled: profile.prompt.workspaceGuidance,
      load: () => createPromptSectionPlugin(WORKSPACE_FILESYSTEM_PROMPT_SECTION),
    },
    {
      id: 'prompt-workspace-instructions',
      revision: profileRevision,
      enabled: workspaceInstructions !== undefined,
      load: () =>
        createPromptSectionPlugin(createWorkspaceInstructionsSection(workspaceInstructions!)),
    },
    {
      id: 'prompt-workspace-command',
      revision: 'v1',
      enabled: profile.prompt.workspaceGuidance,
      load: () => createPromptSectionPlugin(WORKSPACE_COMMAND_PROMPT_SECTION),
    },
    { id: 'compaction', revision: profileRevision, load: () => compaction.plugin },
    { id: 'token-meter', revision: 'v1', load: () => tokenMeter.plugin },
    { id: 'commands', revision: 'v1', load: () => commands.plugin },
    {
      id: 'command-inspect',
      revision: 'v1',
      load: () => createCommandRegistrationPlugin(createInspectCommand()),
    },
    {
      id: 'command-compact',
      revision: profileRevision,
      load: () => createCommandRegistrationPlugin(createCompactCommand(compactor)),
    },
    {
      id: 'command-reload',
      revision: 'v1',
      enabled: reload !== undefined,
      load: () =>
        createCommandRegistrationPlugin({
          name: 'reload',
          description: 'Validate and apply the configured profile between turns',
          cancellation: 'admission-only',
          handler: reload!,
        }),
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
  close(): Promise<void>
}

interface CliRuntimeParts {
  readonly innerModel: ModelAdapter
  readonly createSummary: (model: ModelAdapter) => SummaryAdapter
  readonly approval: ApprovalService
}

interface CliReloadOptions {
  readonly loadConfiguration: () => ResolvedCliConfiguration
  readonly createParts: (configuration: ResolvedCliConfiguration) => CliRuntimeParts
}

function profileFingerprint(configuration: ResolvedCliConfiguration): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        mode: configuration.mode,
        model: configuration.model,
        contextWindow: configuration.contextWindow ?? null,
        workspaceRoot: configuration.workspaceRoot,
        sessionDirectory: configuration.sessionDirectory ?? null,
        profile: configuration.profile,
      }),
    )
    .digest('hex')
}

function reloadError(error: unknown, profilePath?: string): Error {
  const raw = error instanceof Error ? error.message : String(error)
  const message =
    profilePath === undefined ? raw : raw.replaceAll(profilePath, basename(profilePath))
  return new Error(`profile reload rejected: ${message}`, { cause: error })
}

function runtimeManifest(
  configuration: ResolvedCliConfiguration,
  parts: CliRuntimeParts,
  sessions: ReturnType<typeof createSessionStorePlugin>,
  meter: TokenMeter,
  trace: TraceSink,
  env: Readonly<Record<string, string | undefined>>,
  revision: string,
  reload?: CommandDefinition['handler'],
): readonly ManifestEntry[] {
  const filesystemEnabled = configuration.profile.tools.enabled.some(
    (id) => id.startsWith('workspace.') && id !== 'workspace.command',
  )
  const routes = new Map<string, ToolSandbox>()
  if (filesystemEnabled) {
    const filesystemSandbox = new WorkspaceFilesystemSandbox({
      filesystem: new NodeWorkspaceFileSystem({
        root: configuration.workspaceRoot,
        maxFileBytes: configuration.profile.workspace.maxFileBytes,
      }),
    })
    routes.set(WORKSPACE_FILESYSTEM_PROFILE, filesystemSandbox)
    routes.set(WORKSPACE_WRITE_PROFILE, filesystemSandbox)
  }
  if (configuration.profile.tools.enabled.includes('workspace.command')) {
    const processProfile = configuration.profile.process
    const hostEnvironment = commandEnvironment(env)
    const runner =
      processProfile.backend === 'docker'
        ? new DockerWorkspaceProcessRunner({
            root: configuration.workspaceRoot,
            image: processProfile.image,
            allowedPrograms: processProfile.allowedPrograms,
            hostEnvironment,
            maxOutputBytes: processProfile.maxOutputBytes,
            killGraceMs: processProfile.killGraceMs,
            memoryBytes: processProfile.memoryBytes,
            pidsLimit: processProfile.pidsLimit,
            tmpfsBytes: processProfile.tmpfsBytes,
          })
        : new NodeWorkspaceProcessRunner({
            root: configuration.workspaceRoot,
            allowedPrograms: processProfile.allowedPrograms,
            environment: hostEnvironment,
            maxOutputBytes: processProfile.maxOutputBytes,
            killGraceMs: processProfile.killGraceMs,
          })
    routes.set(
      WORKSPACE_COMMAND_PROFILE,
      new WorkspaceCommandSandbox({
        runner,
        timeoutMs: processProfile.timeoutMs,
        maxTimeoutMs: processProfile.maxTimeoutMs,
        ...(processProfile.backend === 'docker'
          ? { provider: 'workspace-process/docker-v1', enforcement: 'full' as const }
          : {}),
      }),
    )
  }
  const sandbox: ToolSandbox =
    routes.size === 0 ? new UnavailableToolSandbox() : new ProfiledToolSandbox(routes)
  const model = new TracingModelAdapter(parts.innerModel, trace)
  const compactor = new SessionCompactor(parts.createSummary(model))
  const policy = new ContextBudgetPolicy({
    compactor,
    meter,
    thresholdRatio: configuration.profile.context.thresholdRatio,
    retainTurns: configuration.profile.context.retainTurns,
    maxOverflowRetries: configuration.profile.context.maxOverflowRetries,
  })
  const instructions = configuration.profile.instructions
  const workspaceInstructions = instructions.enabled
    ? new NodeWorkspaceInstructions({
        workspaceRoot: configuration.workspaceRoot,
        workingDirectory: resolve(configuration.workspaceRoot, instructions.directory),
        maxBytes: instructions.maxBytes,
        maxSourceBytes: instructions.maxSourceBytes,
        projectRootMarkers: instructions.projectRootMarkers,
        instructionFileCandidates: instructions.instructionFileCandidates,
        localInstructionFileCandidates: instructions.localInstructionFileCandidates,
      })
    : undefined
  return manifestFor(
    configuration.profile,
    sessions,
    model,
    compactor,
    meter,
    policy,
    parts.approval,
    sandbox,
    workspaceInstructions,
    `profile:${revision}`,
    reload,
  )
}

async function mountCliRuntime(
  configuration: ResolvedCliConfiguration,
  options: RunCliOptions,
  innerModel: ModelAdapter,
  createSummary: (model: ModelAdapter) => SummaryAdapter,
  approval: ApprovalService = new UnavailableApprovalService(),
  reloadOptions?: CliReloadOptions,
): Promise<MountedCliRuntime> {
  const env = options.env ?? process.env
  const trace = options.trace ?? consoleTrace
  const boot = new AppBoot()
  const stopLifecycleTrace = traceRuntimeLifecycle(boot.context, trace)
  try {
    const sessionStore: SessionStore = configuration.sessionDirectory
      ? new FileSessionStore({ directory: configuration.sessionDirectory })
      : new InMemorySessionStore()
    const tracedSessions = new TracingSessionStore(trace, sessionStore)
    const sessions = createSessionStorePlugin(tracedSessions)
    const meter = new TokenMeter()
    const sessionId =
      options.sessionId ??
      configuration.resumeSessionId ??
      env.HARNESS_SESSION_ID ??
      `cli-${Date.now()}`
    const existingSession = tracedSessions.get(sessionId)
    if (configuration.resumeSessionId !== undefined && options.sessionId === undefined) {
      if (!configuration.sessionDirectory) {
        throw new Error(
          '--resume requires file persistence configured by the profile or environment',
        )
      }
      if (!existingSession) {
        throw new Error(
          `session ${JSON.stringify(sessionId)} was not found; use --sessions to list persisted sessions`,
        )
      }
    }
    let currentConfiguration = configuration
    let currentFingerprint = profileFingerprint(configuration)
    const reload: CommandDefinition['handler'] | undefined = reloadOptions
      ? async ({ rawInput, signal }) => {
          if (rawInput.trim().length > 0) throw new Error('reload does not accept arguments')
          signal?.throwIfAborted()
          trace('cli/reload', { status: 'started', profile: currentConfiguration.profile.name })
          let reconciliationStarted = false
          try {
            const nextConfiguration = reloadOptions.loadConfiguration()
            signal?.throwIfAborted()
            if (nextConfiguration.sessionDirectory !== currentConfiguration.sessionDirectory) {
              throw new Error('persistence cannot change while a session is mounted')
            }
            const nextFingerprint = profileFingerprint(nextConfiguration)
            if (nextFingerprint === currentFingerprint) {
              trace('cli/reload', {
                status: 'unchanged',
                profile: currentConfiguration.profile.name,
              })
              return {
                kind: 'success',
                text: `Profile ${JSON.stringify(currentConfiguration.profile.name)} is unchanged.`,
              }
            }
            const nextParts = reloadOptions.createParts(nextConfiguration)
            const nextManifest = runtimeManifest(
              nextConfiguration,
              nextParts,
              sessions,
              meter,
              trace,
              env,
              nextFingerprint,
              reload,
            )
            signal?.throwIfAborted()
            reconciliationStarted = true
            const result = await boot.reconcile(nextManifest)
            currentConfiguration = nextConfiguration
            currentFingerprint = nextFingerprint
            const changed = result.added.length + result.updated.length + result.removed.length
            trace('cli/reload', {
              status: 'applied',
              profile: nextConfiguration.profile.name,
              added: result.added,
              updated: result.updated,
              removed: result.removed,
            })
            return {
              kind: 'success',
              text: `Reloaded profile ${JSON.stringify(nextConfiguration.profile.name)}; ${changed} runtime ${changed === 1 ? 'entry' : 'entries'} changed.`,
            }
          } catch (error) {
            if (!reconciliationStarted) signal?.throwIfAborted()
            const normalized = reloadError(error, currentConfiguration.profilePath)
            trace('cli/reload', {
              status: 'rejected',
              profile: currentConfiguration.profile.name,
              error: normalized.message,
            })
            throw normalized
          }
        }
      : undefined

    trace('cli/start', {
      mode: configuration.mode,
      interactive: configuration.interactive,
      input: configuration.input,
      model: configuration.model,
      profile: configuration.profile.name,
      profileSource: configuration.profilePath === undefined ? 'default' : 'file',
      tools: configuration.profile.tools.enabled,
      approvalDefault: configuration.profile.approval.default,
      processBackend: configuration.profile.process.backend,
      sessionId,
      sessionStore: configuration.sessionDirectory ? 'file' : 'memory',
      resumed: existingSession !== undefined,
    })
    await boot.reconcile(
      runtimeManifest(
        configuration,
        { innerModel, createSummary, approval },
        sessions,
        meter,
        trace,
        env,
        currentFingerprint,
        reload,
      ),
    )
    const session = existingSession ?? boot.context.sessions.create(sessionId)
    return {
      boot,
      session,
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
  const env = Object.freeze({ ...(options.env ?? process.env) })
  const output = options.output ?? console.log
  const parsed = parseCliArguments(argv, env)
  const trace = options.trace ?? (parsed.quiet ? () => undefined : consoleTrace)
  const invocationOptions = { ...options, env, trace }
  if (parsed.interactive) {
    throw new Error('--interactive must be run through the interactive CLI adapter')
  }
  const configuration = resolveCliConfiguration(parsed, env)

  let runtime: MountedCliRuntime | undefined
  try {
    const innerModel =
      configuration.mode === 'replay'
        ? replayModel(configuration.input, configuration.contextWindow)
        : openRouterModel(configuration, env, invocationOptions, trace, configuration.contextWindow)
    runtime = await mountCliRuntime(
      configuration,
      invocationOptions,
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
  const env = Object.freeze({ ...(options.env ?? process.env) })
  const output = options.output ?? console.log
  const parsed = parseCliArguments(argv, env)
  const trace = options.trace ?? (parsed.quiet ? () => undefined : consoleTrace)
  const invocationOptions = { ...options, env, trace }
  const configuration = resolveCliConfiguration({ ...parsed, interactive: true }, env)
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
  const createParts = (candidate: ResolvedCliConfiguration): CliRuntimeParts => ({
    innerModel:
      candidate.mode === 'replay'
        ? new InteractiveReplayModelAdapter(candidate.contextWindow)
        : openRouterModel(candidate, env, invocationOptions, trace, candidate.contextWindow),
    createSummary:
      candidate.mode === 'replay'
        ? () => ({
            id: 'replay:interactive-summary',
            summarize: async () => 'Earlier conversation compacted for replay.',
          })
        : (model) => new ModelSummaryAdapter(model),
    approval:
      candidate.profile.approval.default === 'ask'
        ? new InteractiveApprovalService(promptApproval)
        : new DenyApprovalService(),
  })
  const initialParts = createParts(configuration)
  let runtime: MountedCliRuntime | undefined
  try {
    runtime = await mountCliRuntime(
      configuration,
      invocationOptions,
      initialParts.innerModel,
      initialParts.createSummary,
      initialParts.approval,
      {
        loadConfiguration() {
          if (configuration.profilePath === undefined) {
            throw new Error('reload requires a profile selected by --profile or HARNESS_PROFILE')
          }
          return resolveCliConfiguration({ ...parsed, interactive: true }, env)
        },
        createParts,
      },
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
