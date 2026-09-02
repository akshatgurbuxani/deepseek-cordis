export const FILESYSTEM_ERROR_CODES = [
  'FS_NOT_FOUND',
  'FS_NOT_DIRECTORY',
  'FS_NOT_TEXT',
  'FS_NOT_REGULAR_FILE',
  'FS_TOO_LARGE',
  'FS_PERMISSION_DENIED',
  'FS_IO_ERROR',
  'FS_STALE_VERSION',
  'FS_NOT_OBSERVED',
  'FS_AMBIGUOUS_EDIT',
  'FS_EDIT_NOT_FOUND',
  'FS_ABORTED',
  'FS_SANDBOX_DENIED',
] as const

export type FileSystemErrorCode = (typeof FILESYSTEM_ERROR_CODES)[number]
export type FileKind = 'file' | 'directory' | 'symlink' | 'other'

export class FileSystemError extends Error {
  readonly code: FileSystemErrorCode

  constructor(code: FileSystemErrorCode, message: string, options: ErrorOptions = {}) {
    super(`${code}: ${message}`, options)
    this.name = 'FileSystemError'
    this.code = code
  }
}

export interface FileTarget {
  /** Provider-owned stable identity; callers must not interpret it as a host path. */
  readonly key: string
  readonly displayPath: string
}

export interface FileStat {
  readonly path: string
  readonly kind: FileKind
  readonly bytes: number
  /** Content version for regular files; null for non-files. */
  readonly version: string | null
}

export interface DirectoryEntry {
  readonly name: string
  readonly kind: FileKind
}

export interface DirectoryListing {
  readonly path: string
  readonly entries: readonly DirectoryEntry[]
  readonly truncated: boolean
}

export interface PathDiscovery {
  readonly path: string
  readonly entries: readonly (DirectoryEntry & { readonly path: string })[]
  readonly truncated: boolean
}

export interface TextRead {
  readonly path: string
  readonly content: string
  readonly bytes: number
  readonly version: string
}

export interface FileWrite {
  readonly path: string
  readonly bytesWritten: number
  readonly created: boolean
  readonly version: string
}

export interface TextReplacement {
  readonly oldText: string
  readonly newText: string
}

export interface PatchPreview {
  readonly path: string
  readonly version: string
  readonly replacements: number
  readonly diff: string
  readonly truncated: boolean
}

export interface FileMove {
  readonly fromPath: string
  readonly toPath: string
  readonly version: string
}

export interface FileDelete {
  readonly path: string
  readonly deletedVersion: string
}

export interface FileOperationOptions {
  readonly signal?: AbortSignal
}

export interface ReadTextOptions extends FileOperationOptions {
  readonly maxBytes: number
}

export interface ListOptions extends FileOperationOptions {
  readonly maxEntries: number
}

export interface FindOptions extends ListOptions {
  readonly maxDepth: number
}

export interface WriteTextOptions extends FileOperationOptions {
  /** null means the target must remain absent. */
  readonly expectedVersion: string | null
}

export interface EditTextOptions extends FileOperationOptions {
  readonly expectedVersion: string
}

export interface PreviewPatchOptions extends FileOperationOptions {
  readonly maxBytes: number
  readonly maxDiffBytes: number
}

export interface PatchTextOptions extends EditTextOptions {
  readonly maxDiffBytes: number
}

export interface MoveFileOptions extends FileOperationOptions {
  readonly expectedSourceVersion: string
  readonly expectedDestinationVersion: null
}

export interface DeleteFileOptions extends FileOperationOptions {
  readonly expectedVersion: string
}

/** Provider-neutral filesystem capability. Targets can only originate at resolve(). */
export interface FileSystem {
  resolve(path: string): FileTarget
  stat(target: FileTarget, options?: FileOperationOptions): Promise<FileStat>
  list(target: FileTarget, options: ListOptions): Promise<DirectoryListing>
  find(target: FileTarget, options: FindOptions): Promise<PathDiscovery>
  readText(target: FileTarget, options: ReadTextOptions): Promise<TextRead>
  writeText(target: FileTarget, content: string, options: WriteTextOptions): Promise<FileWrite>
  editText(
    target: FileTarget,
    oldText: string,
    newText: string,
    options: EditTextOptions,
  ): Promise<FileWrite>
  previewPatch(
    target: FileTarget,
    replacements: readonly TextReplacement[],
    options: PreviewPatchOptions,
  ): Promise<PatchPreview>
  patchText(
    target: FileTarget,
    replacements: readonly TextReplacement[],
    options: PatchTextOptions,
  ): Promise<FileWrite>
  moveFile(source: FileTarget, destination: FileTarget, options: MoveFileOptions): Promise<FileMove>
  deleteFile(target: FileTarget, options: DeleteFileOptions): Promise<FileDelete>
}

export type FileObservation =
  | { readonly state: 'absent' }
  | { readonly state: 'metadata'; readonly version: string }
  | { readonly state: 'content'; readonly version: string }

function observationKey(sessionId: string, target: FileTarget): string {
  return `${sessionId.length}:${sessionId}${target.key}`
}

/**
 * Session-scoped read-before-write policy. It stores no host paths or contents;
 * only provider identities and the exact content versions the user approved.
 */
export class FileObservationPolicy {
  readonly #observations = new Map<string, FileObservation>()

  observeAbsent(sessionId: string, target: FileTarget): void {
    this.#observations.set(observationKey(sessionId, target), { state: 'absent' })
  }

  observeMetadata(sessionId: string, target: FileTarget, version: string): void {
    this.#observations.set(observationKey(sessionId, target), { state: 'metadata', version })
  }

  observeContent(sessionId: string, target: FileTarget, version: string): void {
    this.#observations.set(observationKey(sessionId, target), { state: 'content', version })
  }

  writeGuard(sessionId: string, target: FileTarget): string | null {
    const observation = this.#observations.get(observationKey(sessionId, target))
    if (!observation) {
      throw new FileSystemError(
        'FS_NOT_OBSERVED',
        `${target.displayPath} must be statted or read first`,
      )
    }
    return observation.state === 'absent' ? null : observation.version
  }

  editGuard(sessionId: string, target: FileTarget): string {
    const observation = this.#observations.get(observationKey(sessionId, target))
    if (observation?.state !== 'content') {
      throw new FileSystemError(
        'FS_NOT_OBSERVED',
        `${target.displayPath} must be read before editing`,
      )
    }
    return observation.version
  }

  deleteGuard(sessionId: string, target: FileTarget): string {
    const observation = this.#observations.get(observationKey(sessionId, target))
    if (observation?.state !== 'content') {
      throw new FileSystemError(
        'FS_NOT_OBSERVED',
        `${target.displayPath} must be read before deletion`,
      )
    }
    return observation.version
  }

  moveGuards(
    sessionId: string,
    source: FileTarget,
    destination: FileTarget,
  ): { readonly sourceVersion: string; readonly destinationVersion: null } {
    const sourceVersion = this.deleteGuard(sessionId, source)
    const destinationVersion = this.writeGuard(sessionId, destination)
    if (destinationVersion !== null) {
      throw new FileSystemError(
        'FS_STALE_VERSION',
        `${destination.displayPath} must be confirmed absent before a move`,
      )
    }
    return { sourceVersion, destinationVersion }
  }

  forget(sessionId: string, target: FileTarget): void {
    this.#observations.delete(observationKey(sessionId, target))
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId.length}:${sessionId}`
    for (const key of this.#observations.keys()) {
      if (key.startsWith(prefix)) this.#observations.delete(key)
    }
  }
}
