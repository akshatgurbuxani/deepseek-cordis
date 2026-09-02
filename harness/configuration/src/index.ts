import { snapshot } from '@deepseek-cordis/protocol'

export const HARNESS_PROFILE_SCHEMA_VERSION = 1
export const DEFAULT_PROFILE_NAME = 'default'
export const DEFAULT_OPENROUTER_MODEL = 'openrouter/free'
export const DEFAULT_WORKSPACE_MAX_FILE_BYTES = 1024 * 1024
export const DEFAULT_ALLOWED_PROGRAMS = Object.freeze(['git', 'node', 'npm', 'npx', 'rg'] as const)
export const DEFAULT_PROCESS_TIMEOUT_MS = 120_000
export const DEFAULT_PROCESS_MAX_TIMEOUT_MS = 600_000
export const DEFAULT_PROCESS_MAX_OUTPUT_BYTES = 64_000
export const DEFAULT_PROCESS_KILL_GRACE_MS = 3_000
export const DEFAULT_DOCKER_MEMORY_BYTES = 1024 * 1024 * 1024
export const DEFAULT_DOCKER_PIDS_LIMIT = 256
export const DEFAULT_DOCKER_TMPFS_BYTES = 256 * 1024 * 1024
export const MAX_DOCKER_MEMORY_BYTES = 64 * 1024 * 1024 * 1024
export const MAX_DOCKER_PIDS_LIMIT = 4096
export const MAX_DOCKER_TMPFS_BYTES = 4 * 1024 * 1024 * 1024
export const MAX_PROCESS_TIMER_MS = 2_147_483_647
export const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024
export const DEFAULT_INSTRUCTION_MAX_BYTES = 65_536
export const DEFAULT_INSTRUCTION_MAX_SOURCE_BYTES = 1024 * 1024
export const DEFAULT_PROJECT_ROOT_MARKERS = Object.freeze(['.git'] as const)
export const DEFAULT_INSTRUCTION_FILE_CANDIDATES = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
] as const)
export const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = Object.freeze([
  'AGENTS.local.md',
  'CLAUDE.local.md',
] as const)

export const HARNESS_TOOL_IDS = Object.freeze([
  'add',
  'workspace.create',
  'workspace.read',
  'workspace.list',
  'workspace.find',
  'workspace.stat',
  'workspace.write',
  'workspace.edit',
  'workspace.preview_patch',
  'workspace.patch',
  'workspace.move',
  'workspace.delete',
  'workspace.command',
] as const)

export type HarnessToolId = (typeof HARNESS_TOOL_IDS)[number]

export interface OpenRouterProfileModel {
  readonly provider: 'openrouter'
  readonly id: string
  readonly contextWindow?: number
}

export interface ReplayProfileModel {
  readonly provider: 'replay'
  readonly contextWindow?: number
}

export type ProfileModel = OpenRouterProfileModel | ReplayProfileModel

export interface WorkspaceProfile {
  /** Absolute or profile-file-relative directory. */
  readonly root: string
  readonly maxFileBytes: number
}

export interface ProcessProfileBase {
  readonly allowedPrograms: readonly string[]
  readonly timeoutMs: number
  readonly maxTimeoutMs: number
  readonly maxOutputBytes: number
  readonly killGraceMs: number
}

export interface LocalProcessProfile extends ProcessProfileBase {
  readonly backend: 'local'
}

export interface DockerProcessProfile extends ProcessProfileBase {
  readonly backend: 'docker'
  readonly image: string
  readonly memoryBytes: number
  readonly pidsLimit: number
  readonly tmpfsBytes: number
}

export type ProcessProfile = LocalProcessProfile | DockerProcessProfile

export type PersistenceProfile =
  | { readonly kind: 'memory' }
  | { readonly kind: 'file'; readonly directory: string }

export interface ToolsProfile {
  readonly enabled: readonly HarnessToolId[]
}

export interface PromptProfile {
  readonly identity: boolean
  readonly workspaceGuidance: boolean
  readonly persona?: string
}

export interface WorkspaceInstructionsProfile {
  readonly enabled: boolean
  /** Portable path below workspace.root whose instruction scope applies. */
  readonly directory: string
  readonly maxBytes: number
  readonly maxSourceBytes: number
  readonly projectRootMarkers: readonly string[]
  readonly instructionFileCandidates: readonly string[]
  readonly localInstructionFileCandidates: readonly string[]
}

export interface ApprovalProfile {
  /** Ask through an available interaction channel, otherwise deny. */
  readonly default: 'ask' | 'deny'
}

export interface ContextProfile {
  readonly thresholdRatio: number
  readonly retainTurns: number
  readonly maxOverflowRetries: number
}

export interface HarnessProfile {
  readonly schemaVersion: typeof HARNESS_PROFILE_SCHEMA_VERSION
  readonly name: string
  readonly model: ProfileModel
  readonly workspace: WorkspaceProfile
  readonly process: ProcessProfile
  readonly persistence: PersistenceProfile
  readonly tools: ToolsProfile
  readonly prompt: PromptProfile
  readonly instructions: WorkspaceInstructionsProfile
  readonly approval: ApprovalProfile
  readonly context: ContextProfile
}

type ObjectValue = Record<string, unknown>

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`)
}

function object(value: unknown, source: string, field = 'profile'): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(source, `${field} must be an object`)
  }
  return value as ObjectValue
}

function exactKeys(
  value: ObjectValue,
  allowed: readonly string[],
  source: string,
  field: string,
): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort()
  if (unknown.length > 0) {
    const names = unknown.map((key) => JSON.stringify(key)).join(', ')
    fail(source, `${field} contains unknown ${unknown.length === 1 ? 'field' : 'fields'} ${names}`)
  }
}

function nonEmptyString(value: unknown, source: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(source, `${field} must be a non-empty string`)
  }
  return value
}

function portableRelativePath(value: unknown, source: string, field: string): string {
  const path = nonEmptyString(value, source, field)
  const parts = path.split('/')
  if (
    path.startsWith('/') ||
    path.includes('\0') ||
    path.includes('\\') ||
    /^[A-Za-z]:/.test(path) ||
    parts.some((part) => part.length === 0 || part === '..' || (part === '.' && path !== '.'))
  ) {
    fail(source, `${field} must be a portable relative path without parent traversal`)
  }
  return path
}

function optionalBoolean(
  value: unknown,
  fallback: boolean,
  source: string,
  field: string,
): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(source, `${field} must be a boolean`)
  return value
}

function positiveInteger(
  value: unknown,
  fallback: number,
  source: string,
  field: string,
  allowZero = false,
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    fail(source, `${field} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
  return value as number
}

function pathComponents(
  value: unknown,
  fallback: readonly string[],
  source: string,
  field: string,
): readonly string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) fail(source, `${field} must be an array`)
  const values = value.map((entry, index) => {
    if (
      typeof entry !== 'string' ||
      entry.trim().length === 0 ||
      entry === '.' ||
      entry === '..' ||
      entry.includes('\0') ||
      entry.includes('/') ||
      entry.includes('\\')
    ) {
      fail(source, `${field}[${index}] must be one non-empty path component`)
    }
    return entry
  })
  if (new Set(values).size !== values.length) fail(source, `${field} must not contain duplicates`)
  return values
}

function model(value: unknown, source: string): ProfileModel {
  if (value === undefined) return { provider: 'openrouter', id: DEFAULT_OPENROUTER_MODEL }
  const candidate = object(value, source, 'model')
  exactKeys(candidate, ['provider', 'id', 'contextWindow'], source, 'model')
  const provider = candidate.provider
  if (provider !== 'openrouter' && provider !== 'replay') {
    fail(source, 'model.provider must be "openrouter" or "replay"')
  }
  const contextWindow =
    candidate.contextWindow === undefined
      ? undefined
      : positiveInteger(candidate.contextWindow, 1, source, 'model.contextWindow')
  if (provider === 'replay') {
    if (candidate.id !== undefined) fail(source, 'model.id is not allowed for replay')
    return {
      provider,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    }
  }
  const id =
    candidate.id === undefined
      ? DEFAULT_OPENROUTER_MODEL
      : nonEmptyString(candidate.id, source, 'model.id').trim()
  return {
    provider,
    id,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

function workspace(value: unknown, source: string): WorkspaceProfile {
  if (value === undefined) {
    return { root: '.', maxFileBytes: DEFAULT_WORKSPACE_MAX_FILE_BYTES }
  }
  const candidate = object(value, source, 'workspace')
  exactKeys(candidate, ['root', 'maxFileBytes'], source, 'workspace')
  return {
    root:
      candidate.root === undefined ? '.' : nonEmptyString(candidate.root, source, 'workspace.root'),
    maxFileBytes: positiveInteger(
      candidate.maxFileBytes,
      DEFAULT_WORKSPACE_MAX_FILE_BYTES,
      source,
      'workspace.maxFileBytes',
    ),
  }
}

function processProfile(value: unknown, source: string): ProcessProfile {
  if (value === undefined) {
    return {
      backend: 'local',
      allowedPrograms: [...DEFAULT_ALLOWED_PROGRAMS],
      timeoutMs: DEFAULT_PROCESS_TIMEOUT_MS,
      maxTimeoutMs: DEFAULT_PROCESS_MAX_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
      killGraceMs: DEFAULT_PROCESS_KILL_GRACE_MS,
    }
  }
  const candidate = object(value, source, 'process')
  exactKeys(
    candidate,
    [
      'backend',
      'image',
      'allowedPrograms',
      'timeoutMs',
      'maxTimeoutMs',
      'maxOutputBytes',
      'killGraceMs',
      'memoryBytes',
      'pidsLimit',
      'tmpfsBytes',
    ],
    source,
    'process',
  )
  const allowedPrograms = pathComponents(
    candidate.allowedPrograms,
    DEFAULT_ALLOWED_PROGRAMS,
    source,
    'process.allowedPrograms',
  )
  if (allowedPrograms.length === 0) fail(source, 'process.allowedPrograms must not be empty')
  const timeoutMs = positiveInteger(
    candidate.timeoutMs,
    DEFAULT_PROCESS_TIMEOUT_MS,
    source,
    'process.timeoutMs',
  )
  const maxTimeoutMs = positiveInteger(
    candidate.maxTimeoutMs,
    DEFAULT_PROCESS_MAX_TIMEOUT_MS,
    source,
    'process.maxTimeoutMs',
  )
  if (maxTimeoutMs > MAX_PROCESS_TIMER_MS) {
    fail(source, `process.maxTimeoutMs must not exceed ${MAX_PROCESS_TIMER_MS}`)
  }
  if (timeoutMs > maxTimeoutMs)
    fail(source, 'process.timeoutMs must not exceed process.maxTimeoutMs')
  const maxOutputBytes = positiveInteger(
    candidate.maxOutputBytes,
    DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
    source,
    'process.maxOutputBytes',
  )
  if (maxOutputBytes > MAX_PROCESS_OUTPUT_BYTES) {
    fail(source, `process.maxOutputBytes must not exceed ${MAX_PROCESS_OUTPUT_BYTES}`)
  }
  const killGraceMs = positiveInteger(
    candidate.killGraceMs,
    DEFAULT_PROCESS_KILL_GRACE_MS,
    source,
    'process.killGraceMs',
  )
  if (killGraceMs > MAX_PROCESS_TIMER_MS) {
    fail(source, `process.killGraceMs must not exceed ${MAX_PROCESS_TIMER_MS}`)
  }
  const common: ProcessProfileBase = {
    allowedPrograms,
    timeoutMs,
    maxTimeoutMs,
    maxOutputBytes,
    killGraceMs,
  }
  const backend = candidate.backend ?? 'local'
  if (backend === 'local') {
    for (const field of ['image', 'memoryBytes', 'pidsLimit', 'tmpfsBytes'] as const) {
      if (candidate[field] !== undefined) {
        fail(source, `process.${field} is only allowed for the docker backend`)
      }
    }
    return { backend, ...common }
  }
  if (backend !== 'docker') {
    fail(source, 'process.backend must be "local" or "docker"')
  }
  const memoryBytes = positiveInteger(
    candidate.memoryBytes,
    DEFAULT_DOCKER_MEMORY_BYTES,
    source,
    'process.memoryBytes',
  )
  const pidsLimit = positiveInteger(
    candidate.pidsLimit,
    DEFAULT_DOCKER_PIDS_LIMIT,
    source,
    'process.pidsLimit',
  )
  const tmpfsBytes = positiveInteger(
    candidate.tmpfsBytes,
    DEFAULT_DOCKER_TMPFS_BYTES,
    source,
    'process.tmpfsBytes',
  )
  if (memoryBytes > MAX_DOCKER_MEMORY_BYTES) {
    fail(source, `process.memoryBytes must not exceed ${MAX_DOCKER_MEMORY_BYTES}`)
  }
  if (pidsLimit > MAX_DOCKER_PIDS_LIMIT) {
    fail(source, `process.pidsLimit must not exceed ${MAX_DOCKER_PIDS_LIMIT}`)
  }
  if (tmpfsBytes > MAX_DOCKER_TMPFS_BYTES) {
    fail(source, `process.tmpfsBytes must not exceed ${MAX_DOCKER_TMPFS_BYTES}`)
  }
  if (tmpfsBytes > memoryBytes) {
    fail(source, 'process.tmpfsBytes must not exceed process.memoryBytes')
  }
  return {
    backend,
    ...common,
    image: nonEmptyString(candidate.image, source, 'process.image').trim(),
    memoryBytes,
    pidsLimit,
    tmpfsBytes,
  }
}

function persistence(value: unknown, source: string): PersistenceProfile {
  if (value === undefined) return { kind: 'memory' }
  const candidate = object(value, source, 'persistence')
  exactKeys(candidate, ['kind', 'directory'], source, 'persistence')
  if (candidate.kind === 'memory') {
    if (candidate.directory !== undefined) {
      fail(source, 'persistence.directory is not allowed for memory persistence')
    }
    return { kind: 'memory' }
  }
  if (candidate.kind !== 'file') {
    fail(source, 'persistence.kind must be "memory" or "file"')
  }
  return {
    kind: 'file',
    directory: nonEmptyString(candidate.directory, source, 'persistence.directory'),
  }
}

function tools(value: unknown, source: string): ToolsProfile {
  if (value === undefined) return { enabled: [...HARNESS_TOOL_IDS] }
  const candidate = object(value, source, 'tools')
  exactKeys(candidate, ['enabled'], source, 'tools')
  if (!Array.isArray(candidate.enabled)) fail(source, 'tools.enabled must be an array')
  const known = new Set<string>(HARNESS_TOOL_IDS)
  const enabled = candidate.enabled.map((tool, index) => {
    if (typeof tool !== 'string' || !known.has(tool)) {
      fail(source, `tools.enabled[${index}] is not a recognized tool id`)
    }
    return tool as HarnessToolId
  })
  if (new Set(enabled).size !== enabled.length)
    fail(source, 'tools.enabled must not contain duplicates')
  const selected = new Set(enabled)
  return { enabled: HARNESS_TOOL_IDS.filter((tool) => selected.has(tool)) }
}

function prompt(value: unknown, source: string): PromptProfile {
  if (value === undefined) return { identity: true, workspaceGuidance: true }
  const candidate = object(value, source, 'prompt')
  exactKeys(candidate, ['identity', 'workspaceGuidance', 'persona'], source, 'prompt')
  const persona =
    candidate.persona === undefined
      ? undefined
      : nonEmptyString(candidate.persona, source, 'prompt.persona').trim()
  return {
    identity: optionalBoolean(candidate.identity, true, source, 'prompt.identity'),
    workspaceGuidance: optionalBoolean(
      candidate.workspaceGuidance,
      true,
      source,
      'prompt.workspaceGuidance',
    ),
    ...(persona === undefined ? {} : { persona }),
  }
}

function instructions(value: unknown, source: string): WorkspaceInstructionsProfile {
  if (value === undefined) {
    return {
      enabled: true,
      directory: '.',
      maxBytes: DEFAULT_INSTRUCTION_MAX_BYTES,
      maxSourceBytes: DEFAULT_INSTRUCTION_MAX_SOURCE_BYTES,
      projectRootMarkers: [...DEFAULT_PROJECT_ROOT_MARKERS],
      instructionFileCandidates: [...DEFAULT_INSTRUCTION_FILE_CANDIDATES],
      localInstructionFileCandidates: [...DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES],
    }
  }
  const candidate = object(value, source, 'instructions')
  exactKeys(
    candidate,
    [
      'enabled',
      'directory',
      'maxBytes',
      'maxSourceBytes',
      'projectRootMarkers',
      'instructionFileCandidates',
      'localInstructionFileCandidates',
    ],
    source,
    'instructions',
  )
  return {
    enabled: optionalBoolean(candidate.enabled, true, source, 'instructions.enabled'),
    directory:
      candidate.directory === undefined
        ? '.'
        : portableRelativePath(candidate.directory, source, 'instructions.directory'),
    maxBytes: positiveInteger(
      candidate.maxBytes,
      DEFAULT_INSTRUCTION_MAX_BYTES,
      source,
      'instructions.maxBytes',
      true,
    ),
    maxSourceBytes: positiveInteger(
      candidate.maxSourceBytes,
      DEFAULT_INSTRUCTION_MAX_SOURCE_BYTES,
      source,
      'instructions.maxSourceBytes',
      true,
    ),
    projectRootMarkers: pathComponents(
      candidate.projectRootMarkers,
      DEFAULT_PROJECT_ROOT_MARKERS,
      source,
      'instructions.projectRootMarkers',
    ),
    instructionFileCandidates: pathComponents(
      candidate.instructionFileCandidates,
      DEFAULT_INSTRUCTION_FILE_CANDIDATES,
      source,
      'instructions.instructionFileCandidates',
    ),
    localInstructionFileCandidates: pathComponents(
      candidate.localInstructionFileCandidates,
      DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES,
      source,
      'instructions.localInstructionFileCandidates',
    ),
  }
}

function approval(value: unknown, source: string): ApprovalProfile {
  if (value === undefined) return { default: 'ask' }
  const candidate = object(value, source, 'approval')
  exactKeys(candidate, ['default'], source, 'approval')
  if (candidate.default !== 'ask' && candidate.default !== 'deny') {
    fail(source, 'approval.default must be "ask" or "deny"')
  }
  return { default: candidate.default }
}

function context(value: unknown, source: string): ContextProfile {
  if (value === undefined) {
    return { thresholdRatio: 0.8, retainTurns: 1, maxOverflowRetries: 1 }
  }
  const candidate = object(value, source, 'context')
  exactKeys(candidate, ['thresholdRatio', 'retainTurns', 'maxOverflowRetries'], source, 'context')
  const thresholdRatio = candidate.thresholdRatio ?? 0.8
  if (
    typeof thresholdRatio !== 'number' ||
    !Number.isFinite(thresholdRatio) ||
    thresholdRatio <= 0 ||
    thresholdRatio >= 1
  )
    fail(source, 'context.thresholdRatio must be greater than zero and less than one')
  return {
    thresholdRatio,
    retainTurns: positiveInteger(candidate.retainTurns, 1, source, 'context.retainTurns'),
    maxOverflowRetries: positiveInteger(
      candidate.maxOverflowRetries,
      1,
      source,
      'context.maxOverflowRetries',
      true,
    ),
  }
}

/** Validate, default, clone, and recursively freeze one versioned profile document. */
export function validateHarnessProfile(value: unknown, source = 'harness profile'): HarnessProfile {
  const candidate = object(value, source)
  exactKeys(
    candidate,
    [
      'schemaVersion',
      'name',
      'model',
      'workspace',
      'process',
      'persistence',
      'tools',
      'prompt',
      'instructions',
      'approval',
      'context',
    ],
    source,
    'profile',
  )
  if (candidate.schemaVersion !== HARNESS_PROFILE_SCHEMA_VERSION) {
    fail(source, `schemaVersion must be ${HARNESS_PROFILE_SCHEMA_VERSION}`)
  }
  return snapshot({
    schemaVersion: HARNESS_PROFILE_SCHEMA_VERSION,
    name:
      candidate.name === undefined
        ? DEFAULT_PROFILE_NAME
        : nonEmptyString(candidate.name, source, 'name').trim(),
    model: model(candidate.model, source),
    workspace: workspace(candidate.workspace, source),
    process: processProfile(candidate.process, source),
    persistence: persistence(candidate.persistence, source),
    tools: tools(candidate.tools, source),
    prompt: prompt(candidate.prompt, source),
    instructions: instructions(candidate.instructions, source),
    approval: approval(candidate.approval, source),
    context: context(candidate.context, source),
  })
}

/** Parse one JSON profile without accepting JSON primitives or partial garbage. */
export function parseHarnessProfile(text: string, source = 'harness profile'): HarnessProfile {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${source}: invalid JSON`, { cause: error })
  }
  return validateHarnessProfile(value, source)
}

export const DEFAULT_HARNESS_PROFILE = validateHarnessProfile({
  schemaVersion: HARNESS_PROFILE_SCHEMA_VERSION,
})
