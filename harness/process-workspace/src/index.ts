import { spawn } from 'node:child_process'
import { lstatSync, realpathSync, type Stats, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, relative } from 'node:path'

import {
  ProcessError,
  type ProcessOutput,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
} from '@deepseek-cordis/process'
import type { JsonValue } from '@deepseek-cordis/protocol'
import type {
  SandboxLease,
  SandboxPreparation,
  SandboxRequest,
  ToolSandbox,
} from '@deepseek-cordis/sandbox'
import type { PromptAssemblyContext, PromptSection } from '@deepseek-cordis/system-prompt'
import type { ConsequentialToolDefinition } from '@deepseek-cordis/tools'

export const WORKSPACE_COMMAND_PROFILE = 'workspace-command'
export const WORKSPACE_COMMAND_TOOL = 'run_workspace_command'
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_COMMAND_TIMEOUT_MS = 600_000
export const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 64_000
export const DEFAULT_COMMAND_KILL_GRACE_MS = 3_000
const maxPathBytes = 4096
const maxArguments = 256
const maxArgumentBytes = 16_384
const maxTotalArgumentBytes = 65_536
const maxTimerMs = 2_147_483_647
const maxOutputBytesLimit = 16 * 1024 * 1024

export const WORKSPACE_COMMAND_PROMPT_SECTION: PromptSection = Object.freeze({
  name: 'tool:workspace-command',
  order: 110,
  text: ({ tools }: PromptAssemblyContext) => {
    if (!tools.some(({ name }) => name === WORKSPACE_COMMAND_TOOL)) return ''
    return [
      'Workspace command policy:',
      '- Run focused inspection, build, lint, and test commands with an executable plus argument vector; shell syntax is not interpreted.',
      '- Use only workspace-relative working directories and only configured executable names.',
      '- Check exitCode, timedOut, signal, stderr, and truncation before deciding whether a command succeeded.',
      '- Investigate failures and verify relevant checks before claiming a coding task is complete.',
    ].join('\n')
  },
})

export interface NodeWorkspaceProcessRunnerOptions {
  readonly root: string
  readonly allowedPrograms: readonly string[]
  readonly environment?: Readonly<Record<string, string>>
  readonly maxOutputBytes?: number
  readonly killGraceMs?: number
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`)
}

function isWithin(root: string, target: string): boolean {
  const suffix = relative(root, target)
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}

function oneComponent(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !value.includes('\0') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  )
}

function portableSegments(path: string): readonly string[] {
  if (path === '.') return []
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    Buffer.byteLength(path, 'utf8') > maxPathBytes
  ) {
    throw new ProcessError(
      'PROCESS_WORKSPACE_DENIED',
      'cwd must be a portable workspace-relative path',
    )
  }
  const segments = path.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new ProcessError('PROCESS_WORKSPACE_DENIED', 'cwd contains an invalid path segment')
  }
  return segments
}

function validateArguments(args: readonly string[]): void {
  if (args.length > maxArguments) {
    throw new ProcessError('PROCESS_INVALID_REQUEST', `args exceeds ${maxArguments} entries`)
  }
  let total = 0
  for (const [index, value] of args.entries()) {
    if (value.includes('\0')) {
      throw new ProcessError('PROCESS_INVALID_REQUEST', `args[${index}] contains a NUL byte`)
    }
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > maxArgumentBytes) {
      throw new ProcessError(
        'PROCESS_INVALID_REQUEST',
        `args[${index}] exceeds ${maxArgumentBytes} bytes`,
      )
    }
    total += bytes
  }
  if (total > maxTotalArgumentBytes) {
    throw new ProcessError('PROCESS_INVALID_REQUEST', `args exceeds ${maxTotalArgumentBytes} bytes`)
  }
}

class BoundedTail {
  readonly #limit: number
  #buffer = Buffer.alloc(0)
  #seen = 0

  constructor(limit: number) {
    this.#limit = limit
  }

  push(chunk: Buffer): void {
    this.#seen += chunk.byteLength
    if (chunk.byteLength >= this.#limit) {
      this.#buffer = Buffer.from(chunk.subarray(chunk.byteLength - this.#limit))
      return
    }
    const keep = Math.min(this.#buffer.byteLength, this.#limit - chunk.byteLength)
    this.#buffer = Buffer.concat([this.#buffer.subarray(this.#buffer.byteLength - keep), chunk])
  }

  output(): ProcessOutput {
    return Object.freeze({
      text: this.#buffer.toString('utf8'),
      truncated: this.#seen > this.#limit,
    })
  }
}

/** Node-backed foreground runner with explicit argv, budgets, and partial confinement. */
export class NodeWorkspaceProcessRunner implements ProcessRunner {
  readonly root: string
  readonly allowedPrograms: ReadonlySet<string>
  readonly environment: Readonly<Record<string, string>>
  readonly maxOutputBytes: number
  readonly killGraceMs: number

  constructor(options: NodeWorkspaceProcessRunnerOptions) {
    if (options.allowedPrograms.length === 0)
      throw new RangeError('allowedPrograms must not be empty')
    if (options.allowedPrograms.some((program) => !oneComponent(program))) {
      throw new RangeError(
        'allowedPrograms entries must be executable names without path separators',
      )
    }
    if (new Set(options.allowedPrograms).size !== options.allowedPrograms.length) {
      throw new RangeError('allowedPrograms must not contain duplicates')
    }
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_COMMAND_OUTPUT_BYTES
    this.killGraceMs = options.killGraceMs ?? DEFAULT_COMMAND_KILL_GRACE_MS
    positiveInteger(this.maxOutputBytes, 'maxOutputBytes')
    positiveInteger(this.killGraceMs, 'killGraceMs')
    if (this.maxOutputBytes > maxOutputBytesLimit) {
      throw new RangeError(`maxOutputBytes must not exceed ${maxOutputBytesLimit}`)
    }
    if (this.killGraceMs > maxTimerMs) {
      throw new RangeError(`killGraceMs must not exceed ${maxTimerMs}`)
    }
    try {
      this.root = realpathSync(options.root)
      if (!statSync(this.root).isDirectory()) throw new Error('not a directory')
    } catch (error) {
      throw new ProcessError(
        'PROCESS_WORKSPACE_DENIED',
        'workspace root does not exist or is inaccessible',
        { cause: error },
      )
    }
    this.allowedPrograms = new Set(options.allowedPrograms)
    this.environment = Object.freeze({ ...(options.environment ?? {}) })
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    request.signal?.throwIfAborted()
    if (!oneComponent(request.program)) {
      throw new ProcessError('PROCESS_INVALID_REQUEST', 'program must be one executable name')
    }
    if (!this.allowedPrograms.has(request.program)) {
      throw new ProcessError(
        'PROCESS_NOT_ALLOWED',
        `program ${JSON.stringify(request.program)} is not allowed`,
      )
    }
    if (
      !Number.isInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > maxTimerMs
    ) {
      throw new ProcessError(
        'PROCESS_INVALID_REQUEST',
        `timeoutMs must be a positive integer no greater than ${maxTimerMs}`,
      )
    }
    validateArguments(request.args)
    const cwd = this.#workingDirectory(request.cwd)
    request.signal?.throwIfAborted()

    const stdout = new BoundedTail(this.maxOutputBytes)
    const stderr = new BoundedTail(this.maxOutputBytes)
    const child = spawn(request.program, [...request.args], {
      cwd,
      env: this.environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

    let timedOut = false
    let cancelled = false
    let escalation: ReturnType<typeof setTimeout> | undefined
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        if (process.platform === 'win32' || child.pid === undefined) child.kill('SIGTERM')
        else process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      escalation = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return
        try {
          if (process.platform === 'win32' || child.pid === undefined) child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, this.killGraceMs)
      escalation.unref()
    }
    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, request.timeoutMs)
    timeout.unref()
    const cancel = () => {
      cancelled = true
      terminate()
    }
    request.signal?.addEventListener('abort', cancel, { once: true })

    try {
      const settled = await new Promise<{ exitCode: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once('error', (error) =>
            reject(
              new ProcessError('PROCESS_SPAWN_FAILED', 'command could not be started', {
                cause: error,
              }),
            ),
          )
          child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
        },
      )
      if (cancelled) request.signal?.throwIfAborted()
      return Object.freeze({
        program: request.program,
        args: Object.freeze([...request.args]),
        cwd: request.cwd,
        exitCode: settled.exitCode,
        signal: settled.signal,
        timedOut,
        stdout: stdout.output(),
        stderr: stderr.output(),
      })
    } finally {
      clearTimeout(timeout)
      if (escalation) clearTimeout(escalation)
      request.signal?.removeEventListener('abort', cancel)
    }
  }

  #workingDirectory(path: string): string {
    const segments = portableSegments(path)
    let current = this.root
    for (const segment of segments) {
      current = join(current, segment)
      let status: Stats
      try {
        status = lstatSync(current)
      } catch (error) {
        throw new ProcessError(
          'PROCESS_WORKSPACE_DENIED',
          `cwd ${JSON.stringify(path)} does not exist or is inaccessible`,
          { cause: error },
        )
      }
      if (status.isSymbolicLink()) {
        throw new ProcessError(
          'PROCESS_WORKSPACE_DENIED',
          `cwd ${JSON.stringify(path)} traverses a symbolic link`,
        )
      }
      if (!status.isDirectory()) {
        throw new ProcessError(
          'PROCESS_WORKSPACE_DENIED',
          `cwd ${JSON.stringify(path)} is not a directory`,
        )
      }
    }
    let canonical: string
    try {
      canonical = realpathSync(current)
    } catch (error) {
      throw new ProcessError(
        'PROCESS_WORKSPACE_DENIED',
        `cwd ${JSON.stringify(path)} changed during validation`,
        { cause: error },
      )
    }
    if (!isWithin(this.root, canonical)) {
      throw new ProcessError('PROCESS_WORKSPACE_DENIED', 'cwd escapes the workspace root')
    }
    return canonical
  }
}

export interface WorkspaceCommandSandboxOptions {
  readonly runner: ProcessRunner
  readonly timeoutMs?: number
  readonly maxTimeoutMs?: number
}

function argumentsObject(value: JsonValue): Record<string, JsonValue | undefined> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new ProcessError('PROCESS_INVALID_REQUEST', 'command arguments must be an object')
  }
  const allowed = new Set(['program', 'args', 'cwd', 'timeoutMs'])
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new ProcessError(
      'PROCESS_INVALID_REQUEST',
      `command arguments contain unknown field ${JSON.stringify(unknown.sort()[0])}`,
    )
  }
  return value
}

class ProcessLease implements SandboxLease {
  readonly provider = 'workspace-process/node-argv-v1'
  readonly enforcement = 'partial' as const
  #used = false
  #disposed = false

  constructor(readonly operation: () => Promise<JsonValue>) {}

  async execute(): Promise<JsonValue> {
    if (this.#disposed) throw new Error('command lease is disposed')
    if (this.#used) throw new Error('command lease may execute only once')
    this.#used = true
    return this.operation()
  }

  dispose(): void {
    this.#disposed = true
  }
}

/** Exact-lease adapter from the consequential tool seam to a process runner. */
export class WorkspaceCommandSandbox implements ToolSandbox {
  readonly runner: ProcessRunner
  readonly timeoutMs: number
  readonly maxTimeoutMs: number

  constructor(options: WorkspaceCommandSandboxOptions) {
    this.runner = options.runner
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    this.maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_COMMAND_TIMEOUT_MS
    positiveInteger(this.timeoutMs, 'timeoutMs')
    positiveInteger(this.maxTimeoutMs, 'maxTimeoutMs')
    if (this.maxTimeoutMs > maxTimerMs)
      throw new RangeError(`maxTimeoutMs must not exceed ${maxTimerMs}`)
    if (this.timeoutMs > this.maxTimeoutMs)
      throw new RangeError('timeoutMs must not exceed maxTimeoutMs')
  }

  async prepare(request: SandboxRequest): Promise<SandboxPreparation> {
    request.signal?.throwIfAborted()
    if (
      request.toolName !== WORKSPACE_COMMAND_TOOL ||
      request.profile !== WORKSPACE_COMMAND_PROFILE ||
      request.risk !== 'shell'
    ) {
      return { ok: false, reason: 'workspace command sandbox does not support this operation' }
    }
    try {
      const args = argumentsObject(request.arguments)
      if (typeof args.program !== 'string') {
        throw new ProcessError('PROCESS_INVALID_REQUEST', 'program must be a string')
      }
      const argv = args.args ?? []
      if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
        throw new ProcessError('PROCESS_INVALID_REQUEST', 'args must be an array of strings')
      }
      const cwd = args.cwd ?? '.'
      if (typeof cwd !== 'string') {
        throw new ProcessError('PROCESS_INVALID_REQUEST', 'cwd must be a string')
      }
      const requestedTimeout = args.timeoutMs ?? this.timeoutMs
      if (
        typeof requestedTimeout !== 'number' ||
        !Number.isInteger(requestedTimeout) ||
        requestedTimeout < 1
      ) {
        throw new ProcessError('PROCESS_INVALID_REQUEST', 'timeoutMs must be a positive integer')
      }
      const timeoutMs = Math.min(requestedTimeout, this.maxTimeoutMs)
      return {
        ok: true,
        lease: new ProcessLease(async () => {
          const result = await this.runner.run({
            program: args.program as string,
            args: argv as string[],
            cwd,
            timeoutMs,
            ...(request.signal ? { signal: request.signal } : {}),
          })
          return {
            program: result.program,
            args: [...result.args],
            cwd: result.cwd,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            stdout: { ...result.stdout },
            stderr: { ...result.stderr },
          }
        }),
      }
    } catch (error) {
      request.signal?.throwIfAborted()
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

export function createWorkspaceCommandTool(): ConsequentialToolDefinition {
  const definition: ConsequentialToolDefinition = {
    name: WORKSPACE_COMMAND_TOOL,
    description:
      'Run one allowed executable with an explicit argument vector in the workspace. No shell syntax, stdin, background process, or caller-provided environment is supported.',
    inputSchema: {
      type: 'object',
      properties: {
        program: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          description: 'Foreground timeout in milliseconds; the configured maximum is enforced.',
        },
      },
      required: ['program'],
      additionalProperties: false,
    },
    safety: {
      risk: 'shell',
      approvalReason: 'Run the requested command in the workspace',
      sandbox: { profile: WORKSPACE_COMMAND_PROFILE, requiredEnforcement: 'partial' },
    },
  }
  return Object.freeze(definition)
}

/** Keep only model-friendly, non-secret launch environment entries. */
export function commandEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {
    NO_COLOR: '1',
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    CI: '1',
  }
  for (const name of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const) {
    const value = source[name]
    if (value !== undefined) result[name] = value
  }
  const path = source.PATH
  if (path !== undefined) {
    const absolute = path.split(delimiter).filter((entry) => entry.length > 0 && isAbsolute(entry))
    if (absolute.length > 0) result.PATH = absolute.join(delimiter)
  }
  return Object.freeze(result)
}
