import { snapshot, type ModelRequest, type ModelResponse } from '@deepseek-cordis/protocol'

import type { ModelAdapter } from './index.js'

export class ReplayModelAdapter implements ModelAdapter {
  readonly id: string
  readonly requests: ModelRequest[] = []
  readonly #responses: ModelResponse[]

  constructor(id: string, responses: readonly ModelResponse[]) {
    this.id = id
    this.#responses = responses.map((response) => snapshot(response))
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(snapshot(request))
    const response = this.#responses.shift()
    if (!response) throw new Error(`replay adapter ${JSON.stringify(this.id)} exhausted`)
    return snapshot(response)
  }
}
