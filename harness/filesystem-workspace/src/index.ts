import { createHash, randomUUID } from 'node:crypto'
import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  opendirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  type DeleteFileOptions,
  type DirectoryListing,
  type EditTextOptions,
  type FileDelete,
  type FileKind,
  type FileMove,
  FileObservationPolicy,
  type FileOperationOptions,
  type FileStat,
  type FileSystem,
  FileSystemError,
  type FileTarget,
  type FileWrite,
  type FindOptions,
  type ListOptions,
  type MoveFileOptions,
  type PatchPreview,
  type PatchTextOptions,
  type PathDiscovery,
  type PreviewPatchOptions,
  type ReadTextOptions,
  type TextRead,
  type TextReplacement,
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
export const WORKSPACE_FIND_PATHS_TOOL = 'find_workspace_paths'
export const WORKSPACE_STAT_PATH_TOOL = 'stat_workspace_path'
export const WORKSPACE_WRITE_FILE_TOOL = 'write_workspace_file'
export const WORKSPACE_EDIT_FILE_TOOL = 'edit_workspace_file'
export const WORKSPACE_PREVIEW_PATCH_TOOL = 'preview_workspace_patch'
export const WORKSPACE_PATCH_FILE_TOOL = 'patch_workspace_file'
export const WORKSPACE_MOVE_FILE_TOOL = 'move_workspace_file'
export const WORKSPACE_DELETE_FILE_TOOL = 'delete_workspace_file'
export const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024
export const DEFAULT_MAX_DIRECTORY_ENTRIES = 200
export const DEFAULT_MAX_DISCOVERY_ENTRIES = 500
export const DEFAULT_MAX_DISCOVERY_DEPTH = 8
export const DEFAULT_MAX_PATCH_REPLACEMENTS = 32
export const DEFAULT_MAX_PATCH_DIFF_BYTES = 64 * 1024
export const MAX_DIRECTORY_SCAN_ENTRIES = 10_000
const legacyCreateTool = 'create_workspace_file'
const legacyCreateProfile = 'workspace-create-file'
const maxPathBytes = 4096

const workspaceToolNames = new Set([
  WORKSPACE_READ_FILE_TOOL,
  WORKSPACE_LIST_DIRECTORY_TOOL,
  WORKSPACE_FIND_PATHS_TOOL,
  WORKSPACE_STAT_PATH_TOOL,
  WORKSPACE_WRITE_FILE_TOOL,
  WORKSPACE_EDIT_FILE_TOOL,
  WORKSPACE_PREVIEW_PATCH_TOOL,
  WORKSPACE_PATCH_FILE_TOOL,
  WORKSPACE_MOVE_FILE_TOOL,
  WORKSPACE_DELETE_FILE_TOOL,
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
      '- Use bounded recursive discovery for project shape, and preview multi-hunk patches before applying them.',
      '- Before creating a file, stat it to establish absence. Before replacing a file, stat or read it. Before editing, read it.',
      '- Use edit only when oldText identifies exactly one occurrence; otherwise read again and choose a more precise match.',
      '- Read a source and confirm a destination is absent before moving; read a file before deleting it.',
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

interface PlannedPatch {
  readonly content: string
  readonly diff: string
  readonly truncated: boolean
}

function boundedUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.byteLength <= maxBytes) return { value, truncated: false }
  return {
    value: new TextDecoder('utf-8').decode(encoded.subarray(0, maxBytes)),
    truncated: true,
  }
}

function prefixedLines(prefix: string, value: string): string {
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

function planPatch(
  path: string,
  content: string,
  replacements: readonly TextReplacement[],
  maxDiffBytes: number,
  maxContentBytes: number,
): PlannedPatch {
  checkPositiveInteger(maxDiffBytes, 'maxDiffBytes')
  checkPositiveInteger(maxContentBytes, 'maxContentBytes')
  if (replacements.length === 0) {
    throw new FileSystemError('FS_AMBIGUOUS_EDIT', 'at least one replacement is required')
  }
  const ranges = replacements.map((replacement, index) => {
    if (replacement.oldText.length === 0) {
      throw new FileSystemError(
        'FS_AMBIGUOUS_EDIT',
        `replacement ${index + 1} oldText must not be empty`,
      )
    }
    const start = content.indexOf(replacement.oldText)
    if (start < 0) {
      throw new FileSystemError(
        'FS_EDIT_NOT_FOUND',
        `replacement ${index + 1} oldText was not found`,
      )
    }
    if (content.indexOf(replacement.oldText, start + 1) >= 0) {
      throw new FileSystemError(
        'FS_AMBIGUOUS_EDIT',
        `replacement ${index + 1} oldText matches more than once`,
      )
    }
    return { ...replacement, index, start, end: start + replacement.oldText.length }
  })
  ranges.sort((left, right) => left.start - right.start)
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start < ranges[index - 1]!.end) {
      throw new FileSystemError('FS_AMBIGUOUS_EDIT', 'replacement ranges overlap')
    }
  }
  const updatedBytes =
    Buffer.byteLength(content, 'utf8') +
    ranges.reduce(
      (change, range) =>
        change -
        Buffer.byteLength(range.oldText, 'utf8') +
        Buffer.byteLength(range.newText, 'utf8'),
      0,
    )
  if (updatedBytes > maxContentBytes) {
    throw new FileSystemError('FS_TOO_LARGE', `${path} exceeds ${maxContentBytes} bytes`)
  }
  let updated = content
  for (const range of [...ranges].reverse()) {
    updated = `${updated.slice(0, range.start)}${range.newText}${updated.slice(range.end)}`
  }
  const fullDiff = [
    '*** Begin Patch',
    `*** Update File: ${path}`,
    ...ranges.flatMap((range) => [
      `@@ replacement ${range.index + 1} @@`,
      prefixedLines('-', range.oldText),
      prefixedLines('+', range.newText),
    ]),
    '*** End Patch',
  ].join('\n')
  const bounded = boundedUtf8(fullDiff, maxDiffBytes)
  return { content: updated, diff: bounded.value, truncated: bounded.truncated }
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
    let directory: ReturnType<typeof opendirSync> | undefined
    try {
      directory = opendirSync(hostPath)
      const all: Array<{ readonly name: string; readonly kind: FileKind }> = []
      let scanTruncated = false
      while (true) {
        const entry = directory.readSync()
        if (!entry) break
        if (all.length >= MAX_DIRECTORY_SCAN_ENTRIES) {
          scanTruncated = true
          break
        }
        all.push({
          name: entry.name,
          kind: entry.isFile()
            ? ('file' as const)
            : entry.isDirectory()
              ? ('directory' as const)
              : entry.isSymbolicLink()
                ? ('symlink' as const)
                : ('other' as const),
        })
      }
      all.sort((left, right) => left.name.localeCompare(right.name))
      this.#checkSignal(options.signal)
      return Object.freeze({
        path: target.displayPath,
        entries: Object.freeze(
          all.slice(0, options.maxEntries).map((entry) => Object.freeze(entry)),
        ),
        truncated: scanTruncated || all.length > options.maxEntries,
      })
    } catch (error) {
      failNode(error, `could not list ${target.displayPath}`)
    } finally {
      directory?.closeSync()
    }
    throw new FileSystemError('FS_IO_ERROR', `could not list ${target.displayPath}`)
  }

  async find(target: FileTarget, options: FindOptions): Promise<PathDiscovery> {
    checkPositiveInteger(options.maxEntries, 'maxEntries')
    checkPositiveInteger(options.maxDepth, 'maxDepth')
    this.#checkSignal(options.signal)
    const root = await this.stat(target, options.signal ? { signal: options.signal } : {})
    if (root.kind !== 'directory') {
      throw new FileSystemError('FS_NOT_DIRECTORY', `${target.displayPath} is not a directory`)
    }
    const entries: Array<{
      readonly path: string
      readonly name: string
      readonly kind: FileKind
    }> = []
    let truncated = false
    const visit = async (directoryTarget: FileTarget, depth: number): Promise<void> => {
      if (truncated) return
      const remaining = options.maxEntries - entries.length
      if (remaining < 1) {
        truncated = true
        return
      }
      const listing = await this.list(directoryTarget, {
        maxEntries: remaining + 1,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      for (const entry of listing.entries) {
        if (entries.length >= options.maxEntries) {
          truncated = true
          return
        }
        const path =
          directoryTarget.displayPath === '.'
            ? entry.name
            : `${directoryTarget.displayPath}/${entry.name}`
        entries.push(Object.freeze({ path, name: entry.name, kind: entry.kind }))
        if (entry.kind === 'directory' && depth < options.maxDepth) {
          await visit(this.resolve(path), depth + 1)
          if (truncated) return
        }
      }
      if (listing.truncated) truncated = true
    }
    await visit(target, 1)
    return Object.freeze({
      path: target.displayPath,
      entries: Object.freeze(entries),
      truncated,
    })
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

  async previewPatch(
    target: FileTarget,
    replacements: readonly TextReplacement[],
    options: PreviewPatchOptions,
  ): Promise<PatchPreview> {
    const current = await this.readText(target, {
      maxBytes: options.maxBytes,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const planned = planPatch(
      target.displayPath,
      current.content,
      replacements,
      options.maxDiffBytes,
      this.maxFileBytes,
    )
    return Object.freeze({
      path: target.displayPath,
      version: current.version,
      replacements: replacements.length,
      diff: planned.diff,
      truncated: planned.truncated,
    })
  }

  async patchText(
    target: FileTarget,
    replacements: readonly TextReplacement[],
    options: PatchTextOptions,
  ): Promise<FileWrite> {
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
    const planned = planPatch(
      target.displayPath,
      current.content,
      replacements,
      options.maxDiffBytes,
      this.maxFileBytes,
    )
    return this.writeText(target, planned.content, {
      expectedVersion: current.version,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  async moveFile(
    source: FileTarget,
    destination: FileTarget,
    options: MoveFileOptions,
  ): Promise<FileMove> {
    if (options.expectedDestinationVersion !== null) {
      throw new FileSystemError('FS_STALE_VERSION', 'move destination must be observed absent')
    }
    if (source.key === destination.key) {
      throw new FileSystemError('FS_SANDBOX_DENIED', 'move source and destination must differ')
    }
    this.#checkSignal(options.signal)
    const before = this.#regularFile(source)
    if (versionOf(before.status) !== options.expectedSourceVersion) {
      throw new FileSystemError(
        'FS_STALE_VERSION',
        `${source.displayPath} changed after observation`,
      )
    }
    const destinationPath = this.#hostPath(destination)
    this.#verifiedParent(destination)
    if (this.#optionalStatus(destinationPath)) {
      throw new FileSystemError('FS_STALE_VERSION', `${destination.displayPath} now exists`)
    }
    let linked = false
    try {
      linkSync(before.hostPath, destinationPath)
      linked = true
      const linkedStatus = lstatSync(destinationPath, { bigint: true })
      if (linkedStatus.dev !== before.status.dev || linkedStatus.ino !== before.status.ino) {
        throw new FileSystemError('FS_STALE_VERSION', `${source.displayPath} changed during move`)
      }
      this.#checkSignal(options.signal)
      const sourceStatus = lstatSync(before.hostPath, { bigint: true })
      if (sourceStatus.dev !== before.status.dev || sourceStatus.ino !== before.status.ino) {
        throw new FileSystemError('FS_STALE_VERSION', `${source.displayPath} changed during move`)
      }
      unlinkSync(before.hostPath)
      linked = false
      const status = lstatSync(destinationPath, { bigint: true })
      return Object.freeze({
        fromPath: source.displayPath,
        toPath: destination.displayPath,
        version: versionOf(status),
      })
    } catch (error) {
      if (linked) {
        try {
          unlinkSync(destinationPath)
        } catch (cleanupError) {
          if (nodeErrorCode(cleanupError) !== 'ENOENT') {
            throw new FileSystemError('FS_IO_ERROR', 'move rollback failed', {
              cause: cleanupError,
            })
          }
        }
      }
      if (nodeErrorCode(error) === 'EEXIST') {
        throw new FileSystemError('FS_STALE_VERSION', `${destination.displayPath} now exists`, {
          cause: error,
        })
      }
      failNode(error, `could not move ${source.displayPath} to ${destination.displayPath}`)
    }
  }

  async deleteFile(target: FileTarget, options: DeleteFileOptions): Promise<FileDelete> {
    this.#checkSignal(options.signal)
    const before = this.#regularFile(target)
    const deletedVersion = versionOf(before.status)
    if (deletedVersion !== options.expectedVersion) {
      throw new FileSystemError(
        'FS_STALE_VERSION',
        `${target.displayPath} changed after observation`,
      )
    }
    this.#checkSignal(options.signal)
    try {
      unlinkSync(before.hostPath)
      return Object.freeze({ path: target.displayPath, deletedVersion })
    } catch (error) {
      failNode(error, `could not delete ${target.displayPath}`)
    }
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
  approvalReason = 'perform the requested bounded workspace filesystem operation',
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
      approvalReason,
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
      WORKSPACE_FIND_PATHS_TOOL,
      'Recursively discover a bounded set of workspace paths without following links.',
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
    consequentialTool(
      WORKSPACE_PREVIEW_PATCH_TOOL,
      'Preview a bounded multi-replacement patch and observe the exact file version.',
      {
        path,
        replacements: {
          type: 'array',
          description: 'Non-overlapping exact text replacements.',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
            required: ['oldText', 'newText'],
            additionalProperties: false,
          },
        },
      },
      ['path', 'replacements'],
    ),
    consequentialTool(
      WORKSPACE_PATCH_FILE_TOOL,
      'Atomically apply exact non-overlapping replacements to an observed file version.',
      {
        path,
        replacements: {
          type: 'array',
          description: 'The exact replacements previously reviewed with patch preview.',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
            required: ['oldText', 'newText'],
            additionalProperties: false,
          },
        },
      },
      ['path', 'replacements'],
    ),
    consequentialTool(
      WORKSPACE_MOVE_FILE_TOOL,
      'Move a read regular file to a destination previously confirmed absent; never overwrite.',
      { fromPath: path, toPath: path },
      ['fromPath', 'toPath'],
      'move the observed workspace file without overwriting its destination',
    ),
    consequentialTool(
      WORKSPACE_DELETE_FILE_TOOL,
      'Permanently delete a previously read regular workspace file.',
      { path },
      ['path'],
      'permanently delete the observed workspace file',
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

function replacementsArgument(
  value: Record<string, JsonValue>,
  maxReplacements: number,
): readonly TextReplacement[] {
  const candidate = value.replacements
  if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > maxReplacements) {
    throw new FileSystemError(
      'FS_IO_ERROR',
      `replacements must contain between 1 and ${maxReplacements} items`,
    )
  }
  return candidate.map((item, index) => {
    if (
      item === null ||
      Array.isArray(item) ||
      typeof item !== 'object' ||
      Object.keys(item).length !== 2 ||
      typeof item.oldText !== 'string' ||
      typeof item.newText !== 'string'
    ) {
      throw new FileSystemError(
        'FS_IO_ERROR',
        `replacement ${index + 1} must contain only string oldText and newText`,
      )
    }
    return Object.freeze({ oldText: item.oldText, newText: item.newText })
  })
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
  readonly maxDiscoveryEntries?: number
  readonly maxDiscoveryDepth?: number
  readonly maxPatchReplacements?: number
  readonly maxPatchDiffBytes?: number
}

/** Model-facing exact-call adapter. All filesystem access remains provider-owned. */
export class WorkspaceFilesystemSandbox implements ToolSandbox {
  readonly filesystem: FileSystem
  readonly observations: FileObservationPolicy
  readonly maxReadBytes: number
  readonly maxDirectoryEntries: number
  readonly maxDiscoveryEntries: number
  readonly maxDiscoveryDepth: number
  readonly maxPatchReplacements: number
  readonly maxPatchDiffBytes: number

  constructor(options: WorkspaceFilesystemSandboxOptions) {
    this.filesystem = options.filesystem
    this.observations = options.observations ?? new FileObservationPolicy()
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_TEXT_BYTES
    this.maxDirectoryEntries = options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES
    this.maxDiscoveryEntries = options.maxDiscoveryEntries ?? DEFAULT_MAX_DISCOVERY_ENTRIES
    this.maxDiscoveryDepth = options.maxDiscoveryDepth ?? DEFAULT_MAX_DISCOVERY_DEPTH
    this.maxPatchReplacements = options.maxPatchReplacements ?? DEFAULT_MAX_PATCH_REPLACEMENTS
    this.maxPatchDiffBytes = options.maxPatchDiffBytes ?? DEFAULT_MAX_PATCH_DIFF_BYTES
    checkPositiveInteger(this.maxReadBytes, 'maxReadBytes')
    checkPositiveInteger(this.maxDirectoryEntries, 'maxDirectoryEntries')
    checkPositiveInteger(this.maxDiscoveryEntries, 'maxDiscoveryEntries')
    checkPositiveInteger(this.maxDiscoveryDepth, 'maxDiscoveryDepth')
    checkPositiveInteger(this.maxPatchReplacements, 'maxPatchReplacements')
    checkPositiveInteger(this.maxPatchDiffBytes, 'maxPatchDiffBytes')
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
      case WORKSPACE_FIND_PATHS_TOOL: {
        const args = argumentsObject(request.arguments, ['path'])
        const target = this.filesystem.resolve(stringArgument(args, 'path'))
        return async () => {
          const result = await this.filesystem.find(target, {
            maxEntries: this.maxDiscoveryEntries,
            maxDepth: this.maxDiscoveryDepth,
            ...(request.signal ? { signal: request.signal } : {}),
          })
          return {
            path: result.path,
            entries: result.entries.map((entry) => ({
              path: entry.path,
              name: entry.name,
              kind: entry.kind,
            })),
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
      case WORKSPACE_PREVIEW_PATCH_TOOL: {
        const args = argumentsObject(request.arguments, ['path', 'replacements'])
        const target = this.filesystem.resolve(stringArgument(args, 'path'))
        const replacements = replacementsArgument(args, this.maxPatchReplacements)
        return async () => {
          const result = await this.filesystem.previewPatch(target, replacements, {
            maxBytes: this.maxReadBytes,
            maxDiffBytes: this.maxPatchDiffBytes,
            ...(request.signal ? { signal: request.signal } : {}),
          })
          this.observations.observeContent(request.sessionId, target, result.version)
          return {
            path: result.path,
            version: result.version,
            replacements: result.replacements,
            diff: result.diff,
            truncated: result.truncated,
          }
        }
      }
      case WORKSPACE_PATCH_FILE_TOOL: {
        const args = argumentsObject(request.arguments, ['path', 'replacements'])
        const target = this.filesystem.resolve(stringArgument(args, 'path'))
        const replacements = replacementsArgument(args, this.maxPatchReplacements)
        const expectedVersion = this.observations.editGuard(request.sessionId, target)
        return async () => {
          const result = await this.filesystem.patchText(target, replacements, {
            expectedVersion,
            maxDiffBytes: this.maxPatchDiffBytes,
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
      case WORKSPACE_MOVE_FILE_TOOL: {
        const args = argumentsObject(request.arguments, ['fromPath', 'toPath'])
        const source = this.filesystem.resolve(stringArgument(args, 'fromPath'))
        const destination = this.filesystem.resolve(stringArgument(args, 'toPath'))
        const guards = this.observations.moveGuards(request.sessionId, source, destination)
        return async () => {
          const result = await this.filesystem.moveFile(source, destination, {
            expectedSourceVersion: guards.sourceVersion,
            expectedDestinationVersion: guards.destinationVersion,
            ...(request.signal ? { signal: request.signal } : {}),
          })
          this.observations.forget(request.sessionId, source)
          this.observations.observeContent(request.sessionId, destination, result.version)
          return {
            fromPath: result.fromPath,
            toPath: result.toPath,
            version: result.version,
          }
        }
      }
      case WORKSPACE_DELETE_FILE_TOOL: {
        const args = argumentsObject(request.arguments, ['path'])
        const target = this.filesystem.resolve(stringArgument(args, 'path'))
        const expectedVersion = this.observations.deleteGuard(request.sessionId, target)
        return async () => {
          const result = await this.filesystem.deleteFile(target, {
            expectedVersion,
            ...(request.signal ? { signal: request.signal } : {}),
          })
          this.observations.forget(request.sessionId, target)
          return { path: result.path, deletedVersion: result.deletedVersion }
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
