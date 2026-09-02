/** Provider-neutral contracts for bounded, non-shell command execution. */

export interface ProcessRequest {
  readonly program: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface ProcessOutput {
  readonly text: string
  readonly truncated: boolean
}

export interface ProcessResult {
  readonly program: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly stdout: ProcessOutput
  readonly stderr: ProcessOutput
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>
}

export class ProcessError extends Error {
  constructor(
    readonly code:
      | 'PROCESS_INVALID_REQUEST'
      | 'PROCESS_NOT_ALLOWED'
      | 'PROCESS_WORKSPACE_DENIED'
      | 'PROCESS_SPAWN_FAILED'
      | 'PROCESS_SANDBOX_UNAVAILABLE',
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options)
    this.name = 'ProcessError'
  }
}
