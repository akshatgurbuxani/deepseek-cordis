import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { JsonValue } from '@deepseek-cordis/protocol'
import type {
  SandboxLease,
  SandboxPreparation,
  SandboxRequest,
  ToolSandbox,
} from '@deepseek-cordis/sandbox'
import type { ConsequentialToolDefinition } from '@deepseek-cordis/tools'

export const WORKSPACE_CREATE_FILE_TOOL = 'create_workspace_file'
export const WORKSPACE_WRITE_PROFILE = 'workspace-create-file'
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const maxPathBytes = 4096

export interface WorkspaceFileSandboxOptions {
  readonly root: string
  readonly maxFileBytes?: number
}

interface CreateFileArguments {
  readonly path: string
  readonly content: string
}

interface PreparedTarget extends CreateFileArguments {
  readonly parent: string
  readonly target: string
  readonly displayPath: string
}

export class WorkspaceFileSandboxError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'WorkspaceFileSandboxError'
  }
}

export function createWorkspaceFileTool(): ConsequentialToolDefinition {
  return {
    name: WORKSPACE_CREATE_FILE_TOOL,
    description: 'Create a new UTF-8 file inside the configured workspace without overwriting.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path whose parent directory already exists.',
        },
        content: { type: 'string', description: 'Complete UTF-8 file contents.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    safety: {
      risk: 'filesystem',
      approvalReason: 'create the requested file inside the configured workspace',
      sandbox: {
        profile: WORKSPACE_WRITE_PROFILE,
        requiredEnforcement: 'partial',
      },
    },
  }
}

function parseArguments(value: JsonValue, maxFileBytes: number): CreateFileArguments {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    typeof value.path !== 'string' ||
    typeof value.content !== 'string' ||
    Object.keys(value).some((key) => key !== 'path' && key !== 'content')
  ) {
    throw new WorkspaceFileSandboxError(
      'workspace file arguments must contain only path and content strings',
    )
  }
  if (Buffer.byteLength(value.content, 'utf8') > maxFileBytes) {
    throw new WorkspaceFileSandboxError(`workspace file content exceeds ${maxFileBytes} bytes`)
  }
  return { path: value.path, content: value.content }
}

function pathSegments(path: string): readonly string[] {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    Buffer.byteLength(path, 'utf8') > maxPathBytes
  )
    throw new WorkspaceFileSandboxError('workspace file path must be a portable relative path')
  const segments = path.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new WorkspaceFileSandboxError('workspace file path contains an invalid segment')
  }
  return segments
}

function isWithin(root: string, target: string): boolean {
  const suffix = relative(root, target)
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}

function existingStatus(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}

function verifyTarget(root: string, input: CreateFileArguments): PreparedTarget {
  const segments = pathSegments(input.path)
  const target = resolve(root, ...segments)
  if (!isWithin(root, target) || target === root) {
    throw new WorkspaceFileSandboxError('workspace file path escapes the configured root')
  }
  let parent = root
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment)
    const status = existingStatus(parent)
    if (!status)
      throw new WorkspaceFileSandboxError('workspace file parent directory does not exist')
    if (status.isSymbolicLink()) {
      throw new WorkspaceFileSandboxError('workspace file path crosses a symbolic link')
    }
    if (!status.isDirectory()) {
      throw new WorkspaceFileSandboxError('workspace file parent is not a directory')
    }
  }
  if (!isWithin(root, realpathSync(parent))) {
    throw new WorkspaceFileSandboxError('workspace file parent escapes the configured root')
  }
  if (existingStatus(target)) {
    throw new WorkspaceFileSandboxError('workspace file target already exists')
  }
  return {
    ...input,
    parent,
    target,
    displayPath: segments.join('/'),
  }
}

class CreateFileLease implements SandboxLease {
  readonly provider = 'workspace-file/node-path-v1'
  readonly enforcement = 'partial' as const
  readonly #root: string
  readonly #prepared: PreparedTarget
  readonly #signal: AbortSignal | undefined
  #state: 'ready' | 'executed' | 'disposed' = 'ready'

  constructor(root: string, prepared: PreparedTarget, signal?: AbortSignal) {
    this.#root = root
    this.#prepared = prepared
    this.#signal = signal
  }

  async execute(): Promise<JsonValue> {
    if (this.#state !== 'ready') {
      throw new WorkspaceFileSandboxError('workspace file lease is no longer executable')
    }
    this.#signal?.throwIfAborted()
    const prepared = verifyTarget(this.#root, this.#prepared)
    const temporaryPath = join(prepared.parent, `.deepseek-cordis-${randomUUID()}.tmp`)
    let descriptor: number | undefined
    let linked = false
    let result: JsonValue | undefined
    let operationError: unknown
    let cleanupError: unknown
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      )
      writeFileSync(descriptor, prepared.content, { encoding: 'utf8' })
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      this.#signal?.throwIfAborted()
      linkSync(temporaryPath, prepared.target)
      linked = true
      this.#state = 'executed'
      result = {
        path: prepared.displayPath,
        bytesWritten: Buffer.byteLength(prepared.content, 'utf8'),
        created: true,
      }
    } catch (error) {
      if (this.#signal?.aborted) {
        try {
          this.#signal.throwIfAborted()
        } catch (abortError) {
          operationError = abortError
        }
      } else if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        operationError = new WorkspaceFileSandboxError('workspace file target already exists', {
          cause: error,
        })
      } else if (error instanceof WorkspaceFileSandboxError) {
        operationError = error
      } else {
        operationError = new WorkspaceFileSandboxError('workspace file creation failed', {
          cause: error,
        })
      }
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
        } catch (error) {
          cleanupError = error
        }
      }
      try {
        unlinkSync(temporaryPath)
      } catch (error) {
        if (
          error === null ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        ) {
          if (!linked && cleanupError === undefined) cleanupError = error
        }
      }
    }
    if (operationError !== undefined) throw operationError
    if (cleanupError !== undefined) {
      throw new WorkspaceFileSandboxError('workspace file cleanup failed', {
        cause: cleanupError,
      })
    }
    return result!
  }

  dispose(): void {
    if (this.#state === 'ready') this.#state = 'disposed'
  }
}

export class WorkspaceFileSandbox implements ToolSandbox {
  readonly root: string
  readonly maxFileBytes: number

  constructor(options: WorkspaceFileSandboxOptions) {
    if (
      !Number.isInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES) ||
      (options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES) < 1
    ) {
      throw new RangeError('maxFileBytes must be a positive integer')
    }
    let root: string
    try {
      root = realpathSync(options.root)
    } catch (error) {
      throw new WorkspaceFileSandboxError('workspace root does not exist or is inaccessible', {
        cause: error,
      })
    }
    if (!statSync(root).isDirectory()) throw new Error('workspace root must be a directory')
    this.root = root
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  }

  async prepare(request: SandboxRequest): Promise<SandboxPreparation> {
    request.signal?.throwIfAborted()
    if (
      request.toolName !== WORKSPACE_CREATE_FILE_TOOL ||
      request.risk !== 'filesystem' ||
      request.profile !== WORKSPACE_WRITE_PROFILE
    )
      return { ok: false, reason: 'workspace sandbox does not support this operation' }
    try {
      const input = parseArguments(request.arguments, this.maxFileBytes)
      const prepared = verifyTarget(this.root, input)
      return {
        ok: true,
        lease: new CreateFileLease(this.root, prepared, request.signal),
      }
    } catch (error) {
      request.signal?.throwIfAborted()
      return {
        ok: false,
        reason:
          error instanceof WorkspaceFileSandboxError
            ? error.message
            : 'workspace sandbox could not validate the requested path',
      }
    }
  }
}
