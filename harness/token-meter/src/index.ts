import {
  type ModelMessage,
  snapshot,
  type ToolSchema,
} from '@deepseek-cordis/protocol'
import {
  deriveSessionSurface,
  type Session,
} from '@deepseek-cordis/session'

export const TOKEN_ESTIMATOR_ID = 'four-characters-v1'

export interface TokenSurfaceNode {
  readonly sequence: number
  readonly tokens: number
}

export interface TokenMeasurement {
  readonly logRevision: number
  readonly estimator: typeof TOKEN_ESTIMATOR_ID
  readonly surfaceTokens: number
  readonly toolTokens: number
  readonly totalTokens: number
  readonly nodes: readonly TokenSurfaceNode[]
}

function textTokens(value: string): number {
  return Math.ceil([...value].length / 4)
}

export function estimateMessage(message: ModelMessage): number {
  if (message.role === 'user') return 4 + textTokens(message.content)
  if (message.role === 'assistant' && 'content' in message) {
    return 4 + textTokens(message.content)
  }
  if (message.role === 'assistant') {
    return 4 + message.toolCalls.reduce((total, call) =>
      total + 8 + textTokens(call.id) + textTokens(call.name)
      + textTokens(JSON.stringify(call.arguments)), 0)
  }
  return 8 + textTokens(message.callId) + textTokens(message.name)
    + textTokens(message.ok ? JSON.stringify(message.output) : message.error)
}

export function estimateTools(tools: readonly ToolSchema[]): number {
  return tools.reduce((total, tool) => total + 8
    + textTokens(tool.name)
    + textTokens(tool.description)
    + textTokens(JSON.stringify(tool.inputSchema)), 0)
}

export class TokenMeter {
  measure(session: Session, tools: readonly ToolSchema[] = []): TokenMeasurement {
    const nodes = deriveSessionSurface(session.events).map((node) => ({
      sequence: node.sequence,
      tokens: estimateMessage(node.message),
    }))
    const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0)
    const toolTokens = estimateTools(tools)
    return snapshot({
      logRevision: session.events.length,
      estimator: TOKEN_ESTIMATOR_ID,
      surfaceTokens,
      toolTokens,
      totalTokens: surfaceTokens + toolTokens,
      nodes,
    })
  }
}
