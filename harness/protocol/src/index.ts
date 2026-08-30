export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: JsonValue
}

export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonValue
}

export type ToolExecution =
  | { readonly ok: true; readonly output: JsonValue }
  | { readonly ok: false; readonly error: string }

interface EventBase {
  readonly sequence: number
  readonly turnId: string
}

export type SessionEvent =
  | EventBase & { readonly type: 'turn/start' }
  | EventBase & { readonly type: 'user/message'; readonly content: string }
  | EventBase & { readonly type: 'step/start'; readonly step: number }
  | EventBase & {
    readonly type: 'assistant/tool-calls'
    readonly calls: readonly ToolCall[]
  }
  | EventBase & { readonly type: 'tool/call'; readonly call: ToolCall }
  | EventBase & {
    readonly type: 'tool/result'
    readonly callId: string
    readonly name: string
    readonly ok: true
    readonly output: JsonValue
  }
  | EventBase & {
    readonly type: 'tool/result'
    readonly callId: string
    readonly name: string
    readonly ok: false
    readonly error: string
  }
  | EventBase & { readonly type: 'assistant/message'; readonly content: string }
  | EventBase & {
    readonly type: 'compaction/summary'
    readonly summary: string
    readonly shadowedSequences: readonly number[]
    readonly summarizer: string
  }
  | EventBase & {
    readonly type: 'context-budget/decision'
    readonly model: string
    readonly measuredTokens: number
  } & (
    | {
      readonly trigger: 'pressure'
      readonly contextWindow: number
      readonly thresholdTokens: number
    }
    | {
      readonly trigger: 'context_overflow'
      readonly contextWindow?: number
      readonly thresholdTokens?: never
    }
  ) & (
    | {
      readonly outcome: 'compacted'
      readonly summarySequence: number
      readonly error?: never
    }
    | {
      readonly outcome: 'no_progress'
      readonly summarySequence?: never
      readonly error?: never
    }
    | {
      readonly outcome: 'failed'
      readonly summarySequence?: never
      readonly error: string
    }
  )
  | EventBase & {
    readonly type: 'step/end'
    readonly step: number
    readonly outcome: 'tool_calls' | 'completed' | 'failed' | 'aborted' | 'interrupted'
  }
  | EventBase & { readonly type: 'turn/error'; readonly error: string }
  | EventBase & {
    readonly type: 'turn/end'
    readonly status: 'completed' | 'failed' | 'aborted' | 'interrupted'
  }

export type SessionEventInput = SessionEvent extends infer Event
  ? Event extends { sequence: number }
    ? Omit<Event, 'sequence'>
    : never
  : never

export type ModelMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string }
  | { readonly role: 'assistant'; readonly toolCalls: readonly ToolCall[] }
  | {
    readonly role: 'tool'
    readonly callId: string
    readonly name: string
    readonly ok: true
    readonly output: JsonValue
  }
  | {
    readonly role: 'tool'
    readonly callId: string
    readonly name: string
    readonly ok: false
    readonly error: string
  }

export interface ModelRequest {
  readonly sessionId: string
  readonly turnId: string
  readonly step: number
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ToolSchema[]
}

export type ModelResponse =
  | { readonly type: 'message'; readonly content: string }
  | { readonly type: 'tool_calls'; readonly calls: readonly ToolCall[] }

export type ModelStreamChunk =
  | { readonly type: 'text-delta'; readonly delta: string }
  | {
    readonly type: 'finish'
    readonly reason: 'completed'
    readonly response: ModelResponse
  }
  | {
    readonly type: 'finish'
    readonly reason: 'error'
    readonly error: string
    readonly code?: 'context_window_exceeded'
  }
  | { readonly type: 'finish'; readonly reason: 'aborted' }

export interface RunResult {
  readonly turnId: string
  readonly content: string
  readonly steps: number
}

function freezeObject(value: object, visited: WeakSet<object>): void {
  if (visited.has(value)) return
  visited.add(value)
  Object.freeze(value)
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') freezeObject(child, visited)
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    freezeObject(value, new WeakSet())
  }
  return value
}

export function snapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}
