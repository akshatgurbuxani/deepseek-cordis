import { createHash, randomUUID } from 'node:crypto'
import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  type DirectoryListing,
  type EditTextOptions,
  type FileKind,
  FileObservationPolicy,
  type FileOperationOptions,
  type FileStat,
  type FileSystem,
  FileSystemError,
  type FileTarget,
  type FileWrite,
  type ListOptions,
  type ReadTextOptions,
  type TextRead,
  type WriteTextOptions,
} from '@deepseek-cordis/filesystem'
import type { JsonValue } from '@deepseek-cordis/protocol'
import type {
  SandboxLease,
  SandboxPreparation,
  SandboxRequest,
  ToolSandbox,
} from '@deepseek-cordis/sandbox'
import type { PromptAssemblyContext, PromptSection } from '@deepseek-cordis/system-prompt'
import type { ConsequentialToolDefinition } from '@deepseek-cordis/tools'

export const WORKSPACE_FILESYSTEM_PROFILE = 'workspace-filesystem'
export const WORKSPACE_READ_FILE_TOOL = 'read_workspace_file'
export const WORKSPACE_LIST_DIRECTORY_TOOL = 'list_workspace_directory'
export const WORKSPACE_STAT_PATH_TOOL = 'stat_workspace_path'
export const WORKSPACE_WRITE_FILE_TOOL = 'write_workspace_file'
export const WORKSPACE_EDIT_FILE_TOOL = 'edit_workspace_file'
export const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024
export const DEFAULT_MAX_DIRECTORY_ENTRIES = 200
const legacyCreateTool = 'create_workspace_file'
const legacyCreateProfile = 'workspace-create-file'
const maxPathBytes = 4096

const workspaceToolNames = new Set([
  WORKSPACE_READ_FILE_TOOL,
  WORKSPACE_LIST_DIRECTORY_TOOL,
  WORKSPACE_STAT_PATH_TOOL,
  WORKSPACE_WRITE_FILE_TOOL,
  WORKSPACE_EDIT_FILE_TOOL,
])

export const WORKSPACE_FILESYSTEM_PROMPT_SECTION: PromptSection = Object.freeze({
  name: 'tool:workspace-filesystem',
  order: 100,
  text: ({ tools }: PromptAssemblyContext) => {
    if (!tools.some(({ name }) => workspaceToolNames.has(name))) return ''
    return [
      'Workspace filesystem policy:',
      '- Treat every path as relative to the configured workspace root; never invent or request host paths.',
      '- Inspect before acting: list directories, stat uncertain paths, and read files before reasoning about their contents.',
      '- Before creating a file, stat it to establish absence. Before replacing a file, stat or read it. Before editing, read it.',
      '- Use edit only when oldText identifies exactly one occurrence; otherwise read again and choose a more precise match.',
      '- If an operation reports FS_STALE_VERSION, inspect the latest state and reconsider the change instead of retrying blindly.',
      '- Do not claim a filesystem change succeeded until its tool result confirms the effect.',
    ].join('\n')
  },
})

export interface NodeWorkspaceFileSystemOptions {
  readonly root: string
  readonly maxFileBytes?: number
}

interface OwnedTarget extends FileTarget {
  readonly key: string
  readonly displayPath: string
}

function nodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined
}

function failNode(error: unknown, action: string): never {
  if (error instanceof FileSystemError) throw error
  const code = nodeErrorCode(error)
  if (code === 'ENOENT') throw new FileSystemError('FS_NOT_FOUND', action, { cause: error })
  if (code === 'EACCES' || code === 'EPERM') {
    throw new FileSystemError('FS_PERMISSION_DENIED', action, { cause: error })
  }
  throw new FileSystemError('FS_IO_ERROR', action, { cause: error })
}

function portableSegments(path: string): readonly string[] {
  if (path === '.') return []
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    Buffer.byteLength(path, 'utf8') > maxPathBytes
  )
    throw new FileSystemError(
      'FS_SANDBOX_DENIED',
      'path must be a portable workspace-relative path',
    )
  const segments = path.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new FileSystemError('FS_SANDBOX_DENIED', 'path contains an invalid segment')
  }
  return segments
}

function isWithin(root: string, target: string): boolean {
  const suffix = relative(root, target)
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}

function kindOf(status: BigIntStats): FileKind {
  if (status.isFile()) return 'file'
  if (status.isDirectory()) return 'directory'
  if (status.isSymbolicLink()) return 'symlink'
  return 'other'
}

function versionOf(status: BigIntStats): string {
  const identity = [status.dev, status.ino, status.size, status.mtimeNs, status.ctimeNs].join(':')
  return `sha256:${createHash('sha256').update(identity).digest('hex')}`
}

function checkPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`)
}

/** Node-backed, root-confined provider. Its enforcement is intentionally partial. */
export class NodeWorkspaceFileSystem implements FileSystem {
  readonly root: string
  readonly maxFileBytes: number
  readonly #paths = new WeakMap<FileTarget, string>()

  constructor(options: NodeWorkspaceFileSystemOptions) {
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_TEXT_BYTES
    checkPositiveInteger(maxFileBytes, 'maxFileBytes')
    try {
      this.root = realpathSync(options.root)
      if (!statSync(this.root).isDirectory()) {
        throw new FileSystemError('FS_NOT_DIRECTORY', 'workspace root must be a directory')
      }
    } catch (error) {
      if (error instanceof FileSystemError) throw error
      failNode(error, 'workspace root does not exist or is inaccessible')
    }
    this.maxFileBytes = maxFileBytes
  }

  resolve(path: string): FileTarget {
    const segments = portableSegments(path)
    const hostPath = resolve(this.root, ...segments)
    if (!isWithin(this.root, hostPath)) {
      throw new FileSystemError('FS_SANDBOX_DENIED', 'path escapes the workspace root')
    }
    const displayPath = segments.length === 0 ? '.' : segments.join('/')
    const target: OwnedTarget = Object.freeze({ key: `workspace:${displayPath}`, displayPath })
    this.#paths.set(target, hostPath)
    return target
  }

  async stat(target: FileTarget, options: FileOperationOptions = {}): Promise<FileStat> {
    this.#checkSignal(options.signal)
    const { status } = this.#inspect(target)
    return Object.freeze({
      path: target.displayPath,
      kind: kindOf(status),
      bytes: Number(status.size),
      version: status.isFile() ? versionOf(status) : null,
    })
  }

  async list(target: FileTarget, options: ListOptions): Promise<DirectoryListing> {
    checkPositiveInteger(options.maxEntries, 'maxEntries')
    this.#checkSignal(options.signal)
    const { hostPath, status } = this.#inspect(target)
    if (!status.isDirectory()) {
      throw new FileSystemError('FS_NOT_DIRECTORY', `${target.displayPath} is not a directory`)
    }
    try {
      const all = readdirSync(hostPath, { withFileTypes: true })
        .map((entry) => ({
          name: entry.name,
          kind: entry.isFile()
            ? ('file' as const)
            : entry.isDirectory()
              ? ('directory' as const)
              : entry.isSymbolicLink()
                ? ('symlink' as const)
                : ('other' as const),
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
      this.#checkSignal(options.signal)
      return Object.freeze({
        path: target.displayPath,
        entries: Object.freeze(
          all.slice(0, options.maxEntries).map((entry) => Object.freeze(entry)),
        ),
        truncated: all.length > options.maxEntries,
      })
    } catch (error) {
      failNode(error, `could not list ${target.displayPath}`)
    }
  }

  async readText(target: FileTarget, options: ReadTextOptions): Promise<TextRead> {
    checkPositiveInteger(options.maxBytes, 'maxBytes')
    this.#checkSignal(options.signal)
    const before = this.#regularFile(target)
    const limit = Math.min(options.maxBytes, this.maxFileBytes)
    if (before.status.size > BigInt(limit)) {
      throw new FileSystemError('FS_TOO_LARGE', `${target.displayPath} exceeds ${limit} bytes`)
    }
    try {
      const content = readFileSync(before.hostPath)
      this.#checkSignal(options.signal)
      if (content.byteLength > limit) {
        throw new FileSystemError('FS_TOO_LARGE', `${target.displayPath} exceeds ${limit} bytes`)
      }
      if (content.includes(0)) {
        throw new FileSystemError('FS_NOT_TEXT', `${target.displayPath} contains NUL bytes`)
      }
      let decoded: string
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(content)
      } catch (error) {
        throw new FileSystemError('FS_NOT_TEXT', `${target.displayPath} is not valid UTF-8`, {
          cause: error,
        })
      }
      const after = this.#regularFile(target)
      const version = versionOf(after.status)
      if (version !== versionOf(before.status)) {
        throw new FileSystemError(
          'FS_STALE_VERSION',
          `${target.displayPath} changed while being read`,
        )
      }
      return Object.freeze({
        path: target.displayPath,
        content: decoded,
        bytes: content.byteLength,
        version,
      })
    } catch (error) {
      failNode(error, `could not read ${target.displayPath}`)
    }
  }

  async writeText(
    target: FileTarget,
    content: string,
    options: WriteTextOptions,
  ): Promise<FileWrite> {
    this.#checkContent(target, content)
    this.#checkSignal(options.signal)
    const targetPath = this.#hostPath(target)
    const parent = this.#verifiedParent(target)
    const existing = this.#optionalStatus(targetPath)
    if (existing?.isSymbolicLink()) {
      throw new FileSystemError('FS_SANDBOX_DENIED', `${target.displayPath} is a symbolic link`)
    }
    if (options.expectedVersion === null) {
      if (existing)
        throw new FileSystemError('FS_STALE_VERSION', `${target.displayPath} now exists`)
    } else {
      if (!existing)
        throw new FileSystemError('FS_STALE_VERSION', `${target.displayPath} no longer exists`)
      if (!existing.isFile()) {
        throw new FileSystemError(
          'FS_NOT_REGULAR_FILE',
          `${target.displayPath} is not a regular file`,
        )
      }
      if (versionOf(existing) !== options.expectedVersion) {
        throw new FileSystemError(
          'FS_STALE_VERSION',
          `${target.displayPath} changed after observation`,
        )
      }
    }
    return this.#publish(
      target,
      parent,
      targetPath,
      content,
      options.expectedVersion === null,
      options.signal,
      existing?.mode,
    )
  }

  async editText(
    target: FileTarget,
    oldText: string,
    newText: string,
    options: EditTextOptions,
  ): Promise<FileWrite> {
    if (oldText.length === 0) {
      throw new FileSystemError('FS_AMBIGUOUS_EDIT', 'oldText must not be empty')
    }
    this.#checkSignal(options.signal)
    const current = await this.readText(target, {
      maxBytes: this.maxFileBytes,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (current.version !== options.expectedVersion) {
      throw new FileSystemError(
        'FS_STALE_VERSION',
        `${target.displayPath} changed after observation`,
      )
    }
    const first = current.content.indexOf(oldText)
    if (first < 0) {
      throw new FileSystemError('FS_EDIT_NOT_FOUND', 'oldText was not found')
    }
    if (current.content.indexOf(oldText, first + oldText.length) >= 0) {
      throw new FileSystemError('FS_AMBIGUOUS_EDIT', 'oldText matches more than once')
    }
    const updated = `${current.content.slice(0, first)}${newText}${current.content.slice(first + oldText.length)}`
    return this.writeText(target, updated, {
      expectedVersion: current.version,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  #hostPath(target: FileTarget): string {
    const path = this.#paths.get(target)
    if (!path) throw new FileSystemError('FS_SANDBOX_DENIED', 'target belongs to another provider')
    return path
  }

  #inspect(target: FileTarget): { readonly hostPath: string; readonly status: BigIntStats } {
    const hostPath = this.#hostPath(target)
    this.#verifyAncestors(target)
    try {
      const status = lstatSync(hostPath, { bigint: true })
      if (status.isSymbolicLink()) {
        throw new FileSystemError('FS_SANDBOX_DENIED', `${target.displayPath} is a symbolic link`)
      }
      return { hostPath, status }
    } catch (error) {
      failNode(error, `${target.displayPath} was not found`)
    }
  }

  #regularFile(target: FileTarget): { readonly hostPath: string; readonly status: BigIntStats } {
    const inspected = this.#inspect(target)
    if (!inspected.status.isFile()) {
      throw new FileSystemError(
        'FS_NOT_REGULAR_FILE',
        `${target.displayPath} is not a regular file`,
      )
    }
    return inspected
  }

  #verifiedParent(target: FileTarget): string {
    if (target.displayPath === '.') {
      throw new FileSystemError('FS_SANDBOX_DENIED', 'the workspace root cannot be written')
    }
    this.#verifyAncestors(target)
    return dirname(this.#hostPath(target))
  }

  #verifyAncestors(target: FileTarget): void {
    const segments = target.displayPath === '.' ? [] : target.displayPath.split('/')
    let current = this.root
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment)
      let status: BigIntStats
      try {
        status = lstatSync(current, { bigint: true })
      } catch (error) {
        failNode(error, `parent of ${target.displayPath} was not found`)
      }
      if (status.isSymbolicLink()) {
        throw new FileSystemError(
          'FS_SANDBOX_DENIED',
          `${target.displayPath} crosses a symbolic link`,
        )
      }
      if (!status.isDirectory()) {
        throw new FileSystemError(
          'FS_NOT_DIRECTORY',
          `parent of ${target.displayPath} is not a directory`,
        )
      }
    }
    if (!isWithin(this.root, realpathSync(current))) {
      throw new FileSystemError(
        'FS_SANDBOX_DENIED',
        `${target.displayPath} escapes the workspace root`,
      )
    }
  }

  #optionalStatus(path: string): BigIntStats | undefined {
    try {
      return lstatSync(path, { bigint: true })
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return undefined
      failNode(error, 'could not inspect workspace path')
    }
  }

  #checkContent(target: FileTarget, content: string): void {
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.maxFileBytes) {
      throw new FileSystemError(
        'FS_TOO_LARGE',
        `${target.displayPath} exceeds ${this.maxFileBytes} bytes`,
      )
    }
  }

  #checkSignal(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return
    throw new FileSystemError('FS_ABORTED', 'filesystem operation was cancelled', {
      cause: signal.reason,
    })
  }

  #publish(
    target: FileTarget,
    parent: string,
    targetPath: string,
    content: string,
    create: boolean,
    signal: AbortSignal | undefined,
    existingMode: bigint | undefined,
  ): FileWrite {
    const temporaryPath = join(parent, `.deepseek-cordis-${randomUUID()}.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      )
      writeFileSync(descriptor, content, 'utf8')
      if (!create && existingMode !== undefined) {
        fchmodSync(descriptor, Number(existingMode & 0o777n))
      }
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      this.#checkSignal(signal)
      if (create) linkSync(temporaryPath, targetPath)
      else renameSync(temporaryPath, targetPath)
      const status = lstatSync(targetPath, { bigint: true })
      return Object.freeze({
        path: target.displayPath,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
        created: create,
        version: versionOf(status),
      })
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST') {
        throw new FileSystemError('FS_STALE_VERSION', `${target.displayPath} now exists`, {
          cause: error,
        })
      }
      failNode(error, `could not write ${target.displayPath}`)
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      try {
        unlinkSync(temporaryPath)
      } catch (error) {
        if (nodeErrorCode(error) !== 'ENOENT') failNode(error, 'could not clean up temporary file')
      }
    }
    throw new FileSystemError('FS_IO_ERROR', `could not write ${target.displayPath}`)
  }
}

function consequentialTool(
  name: string,
  description: string,
  properties: Readonly<Record<string, JsonValue>>,
  required: readonly string[],
): ConsequentialToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required: [...required],
      additionalProperties: false,
    },
    safety: {
      risk: 'filesystem',
      approvalReason: 'perform the requested bounded workspace filesystem operation',
      sandbox: { profile: WORKSPACE_FILESYSTEM_PROFILE, requiredEnforcement: 'partial' },
    },
  }
}

export function createWorkspaceFilesystemTools(): readonly ConsequentialToolDefinition[] {
  const path = {
    type: 'string',
    description: 'Portable workspace-relative path; use . for the root.',
  }
  return [
    consequentialTool(
      WORKSPACE_READ_FILE_TOOL,
      'Read one bounded UTF-8 workspace file.',
      { path },
      ['path'],
    ),
    consequentialTool(
      WORKSPACE_LIST_DIRECTORY_TOOL,
      'List one workspace directory without recursion.',
      { path },
      ['path'],
    ),
    consequentialTool(
      WORKSPACE_STAT_PATH_TOOL,
      'Inspect one workspace path, including confirmed absence.',
      { path },
      ['path'],
    ),
    consequentialTool(
      WORKSPACE_WRITE_FILE_TOOL,
      'Create or replace an observed workspace file.',
      {
        path,
        content: { type: 'string', description: 'Complete replacement UTF-8 contents.' },
      },
      ['path', 'content'],
    ),
    consequentialTool(
      WORKSPACE_EDIT_FILE_TOOL,
      'Replace exactly one occurrence in a previously read file.',
      {
        path,
        oldText: { type: 'string', description: 'Non-empty text expected exactly once.' },
        newText: { type: 'string', description: 'Replacement text.' },
      },
      ['path', 'oldText', 'newText'],
    ),
  ]
}

function argumentsObject(value: JsonValue, keys: readonly string[]): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new FileSystemError('FS_IO_ERROR', 'tool arguments must be an object')
  }
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in value))
  ) {
    throw new FileSystemError('FS_IO_ERROR', `tool arguments must contain only ${keys.join(', ')}`)
  }
  return value
}

function stringArgument(value: Record<string, JsonValue>, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string') {
    throw new FileSystemError('FS_IO_ERROR', `${key} must be a string`)
  }
  return candidate
}

class FilesystemLease implements SandboxLease {
  readonly provider: string
  readonly enforcement = 'partial' as const
  readonly #executeOperation: () => Promise<JsonValue>
  #state: 'ready' | 'executed' | 'disposed' = 'ready'

  constructor(
    executeOperation: () => Promise<JsonValue>,
    provider = 'workspace-filesystem/node-path-v1',
  ) {
    this.#executeOperation = executeOperation
    this.provider = provider
  }

  async execute(): Promise<JsonValue> {
    if (this.#state !== 'ready')
      throw new FileSystemError('FS_IO_ERROR', 'filesystem lease is no longer executable')
    this.#state = 'executed'
    return this.#executeOperation()
  }

  dispose(): void {
    if (this.#state === 'ready') this.#state = 'disposed'
  }
}

export interface WorkspaceFilesystemSandboxOptions {
  readonly filesystem: FileSystem
  readonly observations?: FileObservationPolicy
  readonly maxReadBytes?: number
  readonly maxDirectoryEntries?: number
}

/** Model-facing exact-call adapter. All filesystem access remains provider-owned. */
export class WorkspaceFilesystemSandbox implements ToolSandbox {
  readonly filesystem: FileSystem
  readonly observations: FileObservationPolicy
  readonly maxReadBytes: number
  readonly maxDirectoryEntries: number

  constructor(options: WorkspaceFilesystemSandboxOptions) {
    this.filesystem = options.filesystem
    this.observations = options.observations ?? new FileObservationPolicy()
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_TEXT_BYTES
    this.maxDirectoryEntries = options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES
    checkPositiveInteger(this.maxReadBytes, 'maxReadBytes')
    checkPositiveInteger(this.maxDirectoryEntries, 'maxDirectoryEntries')
  }

  async prepare(request: SandboxRequest): Promise<SandboxPreparation> {
    request.signal?.throwIfAborted()
    const legacy = request.toolName === legacyCreateTool && request.profile === legacyCreateProfile
    if (
      request.risk !== 'filesystem' ||
      (!legacy && request.profile !== WORKSPACE_FILESYSTEM_PROFILE)
    ) {
      return { ok: false, reason: 'workspace filesystem does not support this operation' }
    }
    try {
      const operation = this.#operation(request, legacy)
      return {
        ok: true,
        lease: new FilesystemLease(
          operation,
          legacy ? 'workspace-file/node-path-v1' : 'workspace-filesystem/node-path-v1',
        ),
      }
    } catch (error) {
      request.signal?.throwIfAborted()
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  #operation(request: SandboxRequest, legacy: boolean): () => Promise<JsonValue> {
    if (legacy) {
      const args = argumentsObject(request.arguments, ['path', 'content'])
      const target = this.filesystem.resolve(stringArgument(args, 'path'))
      const content = stringArgument(args, 'content')
      return async () => {
        const result = await this.filesystem.writeText(target, content, {
          expectedVersion: null,
          ...(request.signal ? { signal: request.signal } : {}),
        })
        return {
          path: result.path,
          bytesWritten: result.bytesWritten,
          created: result.created,
        }
      }
    }
    switch (request.toolName) {
      case WORKSPACE_STAT_PATH_TOOL: {
        const args = argumentsObject(request.arguments, ['path'])
        const target = this.filesystem.resolve(stringArgument(args, 'path'))
        return async () => {
          try {
            const result = await this.filesystem.stat(
              target,
              request.signal ? { signal: request.signal } : {},
            )
            if (result.version)
              this.observations.observeMetadata(request.sessionId, target, result.version)
            return { exists: true, ...result }
          } catch (error) {
            if (error instanceof FileSystemError && error.code === 'FS_NOT_FOUND') {
              this.observations.observeAbsent(request.sessionId, target)
              return { exists: false, path: target.displayPath }
            }
            throw error
          }
        }
      }
      case WORKSPACE_LIST_DIRECTORY_TOOL: {
        const args = argumentsObject(request.arguments, ['path'])
        const target = this.filesystem.resolve(stringArgument(args, 'path'))
        return async () => {
          const result = await this.filesystem.list(target, {
            maxEntries: this.maxDirectoryEntries,
            ...(request.signal ? { signal: request.signal } : {}),
          })
          return {
            path: result.path,
            entries: result.entries.map((entry) => ({ name: entry.name, kind: entry.kind })),
            truncated: result.truncated,
          }
        }
      }
      case WORKSPACE_READ_FILE_TOOL: {
        const args = argumentsObject(request.arguments, ['path'])
        const target = this.filesystem.resolve(stringArgument(args, 'path'))
        return async () => {
          const result = await this.filesystem.readText(target, {
            maxBytes: this.maxReadBytes,
            ...(request.signal ? { signal: request.signal } : {}),
          })
          this.observations.observeContent(request.sessionId, target, result.version)
          return {
            path: result.path,
            content: result.content,
            bytes: result.bytes,
            version: result.version,
          }
        }
      }
      case WORKSPACE_WRITE_FILE_TOOL: {
        const args = argumentsObject(request.arguments, ['path', 'content'])
        const target = this.filesystem.resolve(stringArgument(args, 'path'))
        const content = stringArgument(args, 'content')
        const expectedVersion = this.observations.writeGuard(request.sessionId, target)
        return async () => {
          const result = await this.filesystem.writeText(target, content, {
            expectedVersion,
            ...(request.signal ? { signal: request.signal } : {}),
          })
          this.observations.observeContent(request.sessionId, target, result.version)
          return {
            path: result.path,
            bytesWritten: result.bytesWritten,
            created: result.created,
            version: result.version,
          }
        }
      }
      case WORKSPACE_EDIT_FILE_TOOL: {
        const args = argumentsObject(request.arguments, ['path', 'oldText', 'newText'])
        const target = this.filesystem.resolve(stringArgument(args, 'path'))
        const expectedVersion = this.observations.editGuard(request.sessionId, target)
        const oldText = stringArgument(args, 'oldText')
        const newText = stringArgument(args, 'newText')
        return async () => {
          const result = await this.filesystem.editText(target, oldText, newText, {
            expectedVersion,
            ...(request.signal ? { signal: request.signal } : {}),
          })
          this.observations.observeContent(request.sessionId, target, result.version)
          return {
            path: result.path,
            bytesWritten: result.bytesWritten,
            created: result.created,
            version: result.version,
          }
        }
      }
      default:
        throw new FileSystemError(
          'FS_IO_ERROR',
          'workspace filesystem does not support this operation',
        )
    }
  }
}
