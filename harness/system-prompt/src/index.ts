import { snapshot, type ToolSchema } from '@deepseek-cordis/protocol'

export interface PromptAssemblyContext {
  readonly sessionId: string
  readonly turnId: string
  readonly step: number
  /** Exact tool schemas that will accompany this assembly. */
  readonly tools: readonly ToolSchema[]
  readonly signal?: AbortSignal
}

export type PromptTextProvider = (context: PromptAssemblyContext) => string | Promise<string>

export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | PromptTextProvider
}

export interface PromptRegistrationOptions {
  /** Session/agent scope. Scoped names shadow matching global names. */
  readonly scope?: string
}

export interface PromptAssembly {
  readonly systemPrompt?: string
  readonly sectionNames: readonly string[]
}

export interface SystemPromptService {
  register(section: PromptSection, options?: PromptRegistrationOptions): () => void
  assemble(context: PromptAssemblyContext): Promise<PromptAssembly>
}

interface RegisteredSection extends PromptSection {
  readonly text: string | PromptTextProvider
}

function validateSection(section: PromptSection): RegisteredSection {
  if (section.name.trim().length === 0) throw new Error('prompt section name must not be empty')
  if (!Number.isFinite(section.order)) {
    throw new RangeError(`prompt section ${JSON.stringify(section.name)} order must be finite`)
  }
  if (typeof section.text !== 'string' && typeof section.text !== 'function') {
    throw new TypeError(`prompt section ${JSON.stringify(section.name)} text is invalid`)
  }
  return Object.freeze({ name: section.name, order: section.order, text: section.text })
}

function scopeName(scope: string | undefined): string {
  return scope === undefined ? 'global scope' : `scope ${JSON.stringify(scope)}`
}

/** Ordered, provider-neutral prompt registry with session-scoped shadowing. */
export class InMemorySystemPrompt implements SystemPromptService {
  readonly #global = new Map<string, RegisteredSection>()
  readonly #scoped = new Map<string, Map<string, RegisteredSection>>()

  register(section: PromptSection, options: PromptRegistrationOptions = {}): () => void {
    const scope = options.scope
    if (scope !== undefined && scope.trim().length === 0) {
      throw new Error('prompt scope must not be empty')
    }
    const normalized = validateSection(section)
    const registry =
      scope === undefined
        ? this.#global
        : (this.#scoped.get(scope) ??
          (() => {
            const created = new Map<string, RegisteredSection>()
            this.#scoped.set(scope, created)
            return created
          })())
    if (registry.has(normalized.name)) {
      throw new Error(
        `prompt section ${JSON.stringify(normalized.name)} is already registered in ${scopeName(scope)}`,
      )
    }
    registry.set(normalized.name, normalized)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (registry.get(normalized.name) === normalized) registry.delete(normalized.name)
      if (scope !== undefined && registry.size === 0) this.#scoped.delete(scope)
    }
  }

  async assemble(context: PromptAssemblyContext): Promise<PromptAssembly> {
    context.signal?.throwIfAborted()
    const isolatedContext: PromptAssemblyContext = Object.freeze({
      sessionId: context.sessionId,
      turnId: context.turnId,
      step: context.step,
      tools: snapshot(context.tools),
      ...(context.signal ? { signal: context.signal } : {}),
    })
    const effective = new Map(this.#global)
    for (const [name, section] of this.#scoped.get(context.sessionId) ?? []) {
      effective.set(name, section)
    }
    const ordered = [...effective.values()].sort((left, right) => {
      const order = left.order - right.order
      if (order !== 0) return order
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    })
    const rendered: Array<{ readonly name: string; readonly text: string }> = []
    for (const section of ordered) {
      context.signal?.throwIfAborted()
      const text =
        typeof section.text === 'string' ? section.text : await section.text(isolatedContext)
      context.signal?.throwIfAborted()
      if (typeof text !== 'string') {
        throw new TypeError(
          `prompt section ${JSON.stringify(section.name)} returned non-string text`,
        )
      }
      const normalized = text.trim()
      if (normalized.length > 0) rendered.push({ name: section.name, text: normalized })
    }
    return snapshot({
      ...(rendered.length > 0
        ? { systemPrompt: rendered.map(({ text }) => text).join('\n\n') }
        : {}),
      sectionNames: rendered.map(({ name }) => name),
    })
  }
}

/** Fail-safe empty implementation for direct embeddings that opt out of prompts. */
export class EmptySystemPrompt implements SystemPromptService {
  register(_section: PromptSection, _options: PromptRegistrationOptions = {}): () => void {
    throw new Error('empty system prompt does not accept registrations')
  }

  async assemble(context: PromptAssemblyContext): Promise<PromptAssembly> {
    context.signal?.throwIfAborted()
    return snapshot({ sectionNames: [] })
  }
}

export const HARNESS_IDENTITY_SECTION: PromptSection = Object.freeze({
  name: 'harness:identity',
  order: -1000,
  text: 'You are an AI coding agent powered by DeepSeek Cordis Harness.',
})
