import type { ModelRequest, ModelResponse } from '@deepseek-cordis/protocol'

export interface ModelAdapter {
  readonly id: string
  complete(request: ModelRequest): Promise<ModelResponse>
}
