import {
  Context,
  type Fiber,
  type Plugin,
} from 'cordis'

import {
  AgentLoop,
  type ModelAdapter,
  SessionStore,
  type ToolDefinition,
  ToolRegistry,
} from '../../006-minimal-harness-slice/src/harness.ts'

declare module 'cordis' {
  interface Context {
    sessions: SessionStore
    tools: ToolRegistry
    model: ModelAdapter
    agentLoop: AgentLoop
  }
}

export interface PluginFactory<T> {
  readonly plugin: Plugin.Function<void>
  readonly value: T
}

function labelPlugin<T extends Plugin>(plugin: T, name: string): T {
  Object.defineProperty(plugin, 'name', { configurable: true, value: name })
  return plugin
}

export function createSessionPlugin(
  store = new SessionStore(),
): PluginFactory<SessionStore> {
  const plugin: Plugin.Function<void> = (context) => {
    context.provide('sessions', store)
  }
  labelPlugin(plugin, 'sessions')
  plugin.provide = 'sessions'
  return { plugin, value: store }
}

export function createToolRegistryPlugin(
  registry = new ToolRegistry(),
): PluginFactory<ToolRegistry> {
  const plugin: Plugin.Function<void> = (context) => {
    context.provide('tools', registry)
  }
  labelPlugin(plugin, 'tools')
  plugin.provide = 'tools'
  return { plugin, value: registry }
}

export function createToolPlugin(definition: ToolDefinition): Plugin.Function<void> {
  const plugin: Plugin.Function<void> = (context) => {
    context.effect(
      () => context.tools.register(definition),
      `register tool ${JSON.stringify(definition.name)}`,
    )
  }
  labelPlugin(plugin, `tool:${definition.name}`)
  plugin.inject = ['tools']
  return plugin
}

export function createModelPlugin(
  adapter: ModelAdapter,
  setupError?: string,
): PluginFactory<ModelAdapter> {
  const plugin: Plugin.Function<void> = (context) => {
    context.provide('model', adapter)
    if (setupError) throw new Error(setupError)
  }
  labelPlugin(plugin, `model:${adapter.id}`)
  plugin.provide = 'model'
  return { plugin, value: adapter }
}

export function createAgentLoopPlugin(
  loop = new AgentLoop(),
): PluginFactory<AgentLoop> {
  const plugin: Plugin.Function<void> = (context) => {
    context.effect(
      () => loop.connect(context.sessions, context.tools, context.model),
      'connect agent loop',
    )
    context.provide('agentLoop', loop)
  }
  labelPlugin(plugin, 'agent-loop')
  plugin.inject = ['sessions', 'tools', 'model']
  plugin.provide = 'agentLoop'
  return { plugin, value: loop }
}

export interface MountedPlugin {
  readonly plugin: Plugin
  readonly fiber: Fiber
}

export async function mountPlugin(context: Context, plugin: Plugin): Promise<MountedPlugin> {
  const fiber = context.plugin(plugin)
  await fiber
  return { plugin, fiber }
}

export type ReplacementResult =
  | { readonly ok: true; readonly current: MountedPlugin }
  | { readonly ok: false; readonly current: MountedPlugin; readonly error: unknown }

export async function replaceWithRollback(
  context: Context,
  current: MountedPlugin,
  replacement: Plugin,
): Promise<ReplacementResult> {
  await current.fiber.dispose()

  const candidate = context.plugin(replacement)
  try {
    await candidate
    return { ok: true, current: { plugin: replacement, fiber: candidate } }
  } catch (error) {
    await candidate.dispose()
    const restored = await mountPlugin(context, current.plugin)
    return { ok: false, current: restored, error }
  }
}
