import { AgentLoop } from '@deepseek-cordis/agent-loop'
import { SessionCompactor } from '@deepseek-cordis/compaction'
import type { ModelAdapter } from '@deepseek-cordis/model'
import {
  InMemorySessionStore,
  type SessionStore,
} from '@deepseek-cordis/session'
import {
  InMemoryToolRegistry,
  type ToolDefinition,
  type ToolRegistry,
} from '@deepseek-cordis/tools'
import type { Plugin } from 'cordis'

export {
  Context as RuntimeContext,
  type Fiber as RuntimeFiber,
  type Plugin as RuntimePlugin,
} from 'cordis'

// Cordis publishes FiberState as an ambient const enum, so it has no reliable
// runtime re-export. Keep the pinned public values available through the adapter.
export const RuntimeFiberState = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

declare module 'cordis' {
  interface Context {
    sessions: SessionStore
    tools: ToolRegistry
    model: ModelAdapter
    agentLoop: AgentLoop
    compaction: SessionCompactor
  }
}

export interface PluginFactory<T> {
  readonly plugin: Plugin.Function<void>
  readonly value: T
}

function namePlugin<T extends Plugin>(plugin: T, name: string): T {
  Object.defineProperty(plugin, 'name', { configurable: true, value: name })
  return plugin
}

export function createSessionStorePlugin(
  store: SessionStore = new InMemorySessionStore(),
): PluginFactory<SessionStore> {
  const plugin: Plugin.Function<void> = (context) => {
    context.provide('sessions', store)
  }
  namePlugin(plugin, 'session-store')
  plugin.provide = 'sessions'
  return { plugin, value: store }
}

export function createToolRegistryPlugin(
  registry: ToolRegistry = new InMemoryToolRegistry(),
): PluginFactory<ToolRegistry> {
  const plugin: Plugin.Function<void> = (context) => {
    context.provide('tools', registry)
  }
  namePlugin(plugin, 'tool-registry')
  plugin.provide = 'tools'
  return { plugin, value: registry }
}

export function createModelAdapterPlugin(
  adapter: ModelAdapter,
): PluginFactory<ModelAdapter> {
  const plugin: Plugin.Function<void> = (context) => {
    context.provide('model', adapter)
  }
  namePlugin(plugin, `model:${adapter.id}`)
  plugin.provide = 'model'
  return { plugin, value: adapter }
}

export function createToolRegistrationPlugin(
  definition: ToolDefinition,
): Plugin.Function<void> {
  const plugin: Plugin.Function<void> = (context) => {
    context.effect(
      () => context.tools.register(definition),
      `register tool ${JSON.stringify(definition.name)}`,
    )
  }
  namePlugin(plugin, `tool:${definition.name}`)
  plugin.inject = ['tools']
  return plugin
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
  namePlugin(plugin, 'agent-loop')
  plugin.inject = ['sessions', 'tools', 'model']
  plugin.provide = 'agentLoop'
  return { plugin, value: loop }
}

export function createCompactionPlugin(
  compactor: SessionCompactor,
): PluginFactory<SessionCompactor> {
  const plugin: Plugin.Function<void> = (context) => {
    context.provide('compaction', compactor)
  }
  namePlugin(plugin, 'compaction')
  plugin.provide = 'compaction'
  return { plugin, value: compactor }
}
