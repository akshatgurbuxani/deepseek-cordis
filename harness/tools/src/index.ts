import {
  type JsonValue,
  snapshot,
  type ToolExecution,
  type ToolSchema,
} from '@deepseek-cordis/protocol'

export interface ToolDefinition extends ToolSchema {
  readonly execute: (argumentsValue: JsonValue) => JsonValue | Promise<JsonValue>
}

export interface ToolRegistry {
  readonly size: number
  register(definition: ToolDefinition): () => void
  schemas(): readonly ToolSchema[]
  execute(name: string, argumentsValue: JsonValue): Promise<ToolExecution>
}

export class InMemoryToolRegistry implements ToolRegistry {
  readonly #definitions = new Map<string, ToolDefinition>()

  get size(): number {
    return this.#definitions.size
  }

  register(definition: ToolDefinition): () => void {
    if (this.#definitions.has(definition.name)) {
      throw new Error(`tool ${JSON.stringify(definition.name)} is already registered`)
    }
    this.#definitions.set(definition.name, definition)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.#definitions.get(definition.name) === definition) {
        this.#definitions.delete(definition.name)
      }
    }
  }

  schemas(): readonly ToolSchema[] {
    return [...this.#definitions.values()].map(({ name, description, inputSchema }) =>
      snapshot({ name, description, inputSchema }),
    )
  }

  async execute(name: string, argumentsValue: JsonValue): Promise<ToolExecution> {
    const definition = this.#definitions.get(name)
    if (!definition) {
      return { ok: false, error: `tool ${JSON.stringify(name)} is not registered` }
    }
    try {
      const isolatedArguments = snapshot(argumentsValue)
      const output = await definition.execute(isolatedArguments)
      return { ok: true, output: snapshot(output) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
