import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { snapshot } from '@deepseek-cordis/protocol'
import type { PromptAssemblyContext, PromptSection } from '@deepseek-cordis/system-prompt'

export const DEFAULT_INSTRUCTION_MAX_BYTES = 65_536
export const DEFAULT_INSTRUCTION_MAX_SOURCE_BYTES = 1_048_576
export const DEFAULT_PROJECT_ROOT_MARKERS = Object.freeze(['.git'] as const)
export const DEFAULT_INSTRUCTION_FILE_CANDIDATES = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
] as const)
export const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = Object.freeze([
  'AGENTS.local.md',
  'CLAUDE.local.md',
] as const)
export const WORKSPACE_INSTRUCTIONS_SECTION_NAME = 'workspace:instructions'
export const WORKSPACE_INSTRUCTIONS_SECTION_ORDER = -250

export interface WorkspaceInstructionSource {
  /** Portable path relative to the discovered project root. */
  readonly path: string
  readonly bytes: number
  readonly content: string
}

export type WorkspaceInstructionOmissionReason =
  | 'unavailable'
  | 'symbolic-link'
  | 'not-regular-file'
  | 'source-budget'
  | 'invalid-utf8'
  | 'changed-during-read'

export interface WorkspaceInstructionOmission {
  readonly path: string
  readonly reason: WorkspaceInstructionOmissionReason
}

export interface WorkspaceInstructionSnapshot {
  /** Portable discovered root relative to workspaceRoot; never an absolute host path. */
  readonly projectRoot: string
  readonly sources: readonly WorkspaceInstructionSource[]
  readonly omissions: readonly WorkspaceInstructionOmission[]
}

export interface NodeWorkspaceInstructionsOptions {
  /** Hard real-path boundary for every discovered source. */
  readonly workspaceRoot: string
  /** Directory whose instruction scope applies; defaults to workspaceRoot. */
  readonly workingDirectory?: string
  readonly maxBytes: number
  readonly maxSourceBytes?: number
  readonly projectRootMarkers?: readonly string[]
  readonly instructionFileCandidates?: readonly string[]
  readonly localInstructionFileCandidates?: readonly string[]
}

interface NormalizedOptions {
  readonly workspaceRoot: string
  readonly workingDirectory: string
  readonly maxBytes: number
  readonly maxSourceBytes: number
  readonly projectRootMarkers: readonly string[]
  readonly instructionFileCandidates: readonly string[]
  readonly localInstructionFileCandidates: readonly string[]
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`)
  }
  return value
}

function components(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array`)
  const normalized = values.map((value, index) => {
    if (
      typeof value !== 'string' ||
      value.trim().length === 0 ||
      value !== basename(value) ||
      value === '.' ||
      value === '..' ||
      value.includes('\0') ||
      value.includes('/') ||
      value.includes('\\')
    ) {
      throw new Error(`${field}[${index}] must be one non-empty path component`)
    }
    return value
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field} must not contain duplicates`)
  }
  return Object.freeze(normalized)
}

function normalize(options: NodeWorkspaceInstructionsOptions): NormalizedOptions {
  if (typeof options.workspaceRoot !== 'string' || !isAbsolute(options.workspaceRoot)) {
    throw new Error('workspaceRoot must be absolute')
  }
  const workingDirectory = options.workingDirectory ?? options.workspaceRoot
  if (typeof workingDirectory !== 'string' || !isAbsolute(workingDirectory)) {
    throw new Error('workingDirectory must be absolute')
  }
  return Object.freeze({
    workspaceRoot: resolve(options.workspaceRoot),
    workingDirectory: resolve(workingDirectory),
    maxBytes: nonNegativeInteger(options.maxBytes, 'maxBytes'),
    maxSourceBytes: nonNegativeInteger(
      options.maxSourceBytes ?? DEFAULT_INSTRUCTION_MAX_SOURCE_BYTES,
      'maxSourceBytes',
    ),
    projectRootMarkers: components(
      options.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS,
      'projectRootMarkers',
    ),
    instructionFileCandidates: components(
      options.instructionFileCandidates ?? DEFAULT_INSTRUCTION_FILE_CANDIDATES,
      'instructionFileCandidates',
    ),
    localInstructionFileCandidates: components(
      options.localInstructionFileCandidates ?? DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES,
      'localInstructionFileCandidates',
    ),
  })
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function portable(path: string): string {
  return path.split(sep).join('/') || '.'
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function directoryChain(root: string, leaf: string): readonly string[] {
  const chain: string[] = []
  let cursor = leaf
  while (true) {
    chain.push(cursor)
    if (cursor === root) break
    cursor = dirname(cursor)
  }
  return chain.reverse()
}

function sameFile(before: Awaited<ReturnType<typeof lstat>>, after: typeof before): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  )
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ readonly bytes: Buffer; readonly exceeded: boolean }> {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= maxBytes) {
    signal?.throwIfAborted()
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
    if (bytesRead === 0) break
    chunks.push(buffer.subarray(0, bytesRead))
    total += bytesRead
  }
  return { bytes: Buffer.concat(chunks, total), exceeded: total > maxBytes }
}

async function readCandidate(
  filename: string,
  displayPath: string,
  maxSourceBytes: number,
  signal?: AbortSignal,
): Promise<WorkspaceInstructionSource | WorkspaceInstructionOmission | undefined> {
  signal?.throwIfAborted()
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(filename)
  } catch (error) {
    signal?.throwIfAborted()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return { path: displayPath, reason: 'unavailable' }
  }
  signal?.throwIfAborted()
  if (before.isSymbolicLink()) return { path: displayPath, reason: 'symbolic-link' }
  if (!before.isFile()) return { path: displayPath, reason: 'not-regular-file' }
  if (before.size > maxSourceBytes) return { path: displayPath, reason: 'source-budget' }

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (!sameFile(before, opened)) {
      return { path: displayPath, reason: 'changed-during-read' }
    }
    const { bytes, exceeded } = await readBounded(handle, maxSourceBytes, signal)
    signal?.throwIfAborted()
    if (exceeded) return { path: displayPath, reason: 'source-budget' }
    const after = await handle.stat()
    if (!sameFile(opened, after) || bytes.byteLength !== opened.size) {
      return { path: displayPath, reason: 'changed-during-read' }
    }
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
    } catch {
      return { path: displayPath, reason: 'invalid-utf8' }
    }
    if (content.length === 0) return undefined
    return { path: displayPath, bytes: bytes.byteLength, content }
  } catch (error) {
    signal?.throwIfAborted()
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return { path: displayPath, reason: 'changed-during-read' }
    }
    return { path: displayPath, reason: 'unavailable' }
  } finally {
    await handle?.close()
  }
}

function sourceBlock(source: WorkspaceInstructionSource, content = source.content): string {
  const safe = content.replaceAll('</workspace-instructions>', '<\\/workspace-instructions>')
  return `Instructions from: ${source.path}\n\n${safe}`
}

function frame(blocks: readonly string[], notice?: string): string {
  return [
    '<workspace-instructions>',
    'The following workspace instructions apply to this work. More specific instructions appear later and take precedence over broader workspace instructions. They do not override system, developer, or direct user instructions.',
    ...blocks,
    ...(notice ? [notice] : []),
    '</workspace-instructions>',
  ].join('\n\n')
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/** Render a bounded prompt, retaining the most-specific sources first. */
export function renderWorkspaceInstructions(
  discovery: WorkspaceInstructionSnapshot,
  maxBytes: number,
): string {
  nonNegativeInteger(maxBytes, 'maxBytes')
  if (maxBytes === 0) return ''
  const sourceBudgetOmissions = discovery.omissions
    .filter(({ reason }) => reason === 'source-budget')
    .map(({ path }) => path)
  const notice = (
    aggregateOmissions: readonly string[],
    truncated?: string,
  ): string | undefined => {
    const lines = [
      ...(sourceBudgetOmissions.length === 0
        ? []
        : [`Instructions omitted by source budget: ${sourceBudgetOmissions.join(', ')}`]),
      ...(aggregateOmissions.length === 0
        ? []
        : [`Broader instructions omitted by aggregate budget: ${aggregateOmissions.join(', ')}`]),
      ...(truncated === undefined
        ? []
        : [`Instruction content truncated by aggregate budget: ${truncated}`]),
    ]
    return lines.length === 0 ? undefined : lines.join('\n')
  }
  if (discovery.sources.length === 0) {
    const rendered = frame([], notice([]))
    return Buffer.byteLength(rendered) <= maxBytes && sourceBudgetOmissions.length > 0
      ? rendered
      : ''
  }
  const retained = [...discovery.sources]
  const omitted: string[] = []
  while (
    retained.length > 1 &&
    Buffer.byteLength(
      frame(
        retained.map((source) => sourceBlock(source)),
        notice(omitted),
      ),
    ) > maxBytes
  ) {
    omitted.push(retained.shift()!.path)
  }
  let rendered = frame(
    retained.map((source) => sourceBlock(source)),
    notice(omitted),
  )
  if (Buffer.byteLength(rendered) <= maxBytes) return rendered

  const source = retained[0]!
  const budgetNotice = notice(omitted, source.path)
  const empty = frame([sourceBlock(source, '')], budgetNotice)
  if (Buffer.byteLength(empty) > maxBytes) return ''
  const available = maxBytes - Buffer.byteLength(empty)
  rendered = frame([sourceBlock(source, utf8Prefix(source.content, available))], budgetNotice)
  while (Buffer.byteLength(rendered) > maxBytes) {
    const overflow = Buffer.byteLength(rendered) - maxBytes
    const shortened = utf8Prefix(source.content, Math.max(0, available - overflow))
    rendered = frame([sourceBlock(source, shortened)], budgetNotice)
  }
  return rendered
}

/** Node-backed discovery with no watcher, cache, or process-global session state. */
export class NodeWorkspaceInstructions {
  readonly #options: NormalizedOptions

  constructor(options: NodeWorkspaceInstructionsOptions) {
    this.#options = normalize(options)
  }

  get maxBytes(): number {
    return this.#options.maxBytes
  }

  async discover(signal?: AbortSignal): Promise<WorkspaceInstructionSnapshot> {
    signal?.throwIfAborted()
    let boundary: string
    let workingDirectory: string
    try {
      ;[boundary, workingDirectory] = await Promise.all([
        realpath(this.#options.workspaceRoot),
        realpath(this.#options.workingDirectory),
      ])
    } catch (error) {
      signal?.throwIfAborted()
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return snapshot({
          projectRoot: '.',
          sources: [],
          omissions: [],
        })
      }
      throw error
    }
    if (!isWithin(boundary, workingDirectory)) {
      throw new Error('workingDirectory must remain within workspaceRoot')
    }

    let projectRoot = boundary
    let cursor = workingDirectory
    while (true) {
      signal?.throwIfAborted()
      const markerResults = await Promise.all(
        this.#options.projectRootMarkers.map((marker) => exists(join(cursor, marker))),
      )
      signal?.throwIfAborted()
      if (markerResults.some(Boolean)) {
        projectRoot = cursor
        break
      }
      if (cursor === boundary) break
      cursor = dirname(cursor)
    }

    const sources: WorkspaceInstructionSource[] = []
    const omissions: WorkspaceInstructionOmission[] = []
    for (const directory of directoryChain(projectRoot, workingDirectory)) {
      const seen = new Set<string>()
      const candidates = [
        ...this.#options.instructionFileCandidates,
        ...this.#options.localInstructionFileCandidates,
      ]
      for (const candidate of candidates) {
        signal?.throwIfAborted()
        const path = join(directory, candidate)
        const displayPath = portable(relative(projectRoot, path))
        const result = await readCandidate(path, displayPath, this.#options.maxSourceBytes, signal)
        if (result === undefined) continue
        if ('reason' in result) {
          omissions.push(result)
          continue
        }
        if (seen.has(result.content)) continue
        seen.add(result.content)
        sources.push(result)
      }
    }
    return snapshot({ projectRoot: portable(relative(boundary, projectRoot)), sources, omissions })
  }

  async render(context: PromptAssemblyContext): Promise<string> {
    context.signal?.throwIfAborted()
    if (this.#options.maxBytes === 0) return ''
    const discovery = await this.discover(context.signal)
    context.signal?.throwIfAborted()
    return renderWorkspaceInstructions(discovery, this.#options.maxBytes)
  }
}

export function createWorkspaceInstructionsSection(
  provider: NodeWorkspaceInstructions,
): PromptSection {
  return Object.freeze({
    name: WORKSPACE_INSTRUCTIONS_SECTION_NAME,
    order: WORKSPACE_INSTRUCTIONS_SECTION_ORDER,
    text: (context: PromptAssemblyContext) => provider.render(context),
  })
}
