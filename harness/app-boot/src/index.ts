import {
  RuntimeContext,
  RuntimeFiberState,
  type RuntimeFiber,
  type RuntimePlugin,
} from '@deepseek-cordis/runtime-cordis'

export interface ManifestEntry {
  readonly id: string
  readonly parentId?: string
  readonly revision: string
  readonly enabled?: boolean
  readonly context?: RuntimeContext
  readonly load: () => RuntimePlugin | Promise<RuntimePlugin>
}

interface NormalizedEntry {
  readonly id: string
  readonly parentId: string | undefined
  readonly revision: string
  readonly enabled: boolean
  readonly context: RuntimeContext
  readonly load: () => RuntimePlugin | Promise<RuntimePlugin>
  readonly depth: number
  readonly active: boolean
}

interface MountedSnapshot {
  readonly plugin: RuntimePlugin
  readonly fiber: RuntimeFiber
  readonly revision: string
  readonly context: RuntimeContext
}

export class EntryHandle {
  readonly id: string
  parentId: string | undefined
  revision: string | undefined
  enabled = false
  context: RuntimeContext | undefined
  plugin: RuntimePlugin | undefined
  fiber: RuntimeFiber | undefined

  constructor(id: string) {
    this.id = id
  }

  get active(): boolean {
    return this.fiber?.state === RuntimeFiberState.ACTIVE
  }
}

export interface ReconcileResult {
  readonly added: readonly string[]
  readonly updated: readonly string[]
  readonly removed: readonly string[]
  readonly preserved: readonly string[]
}

export class AppBoot {
  readonly context: RuntimeContext
  readonly #handles = new Map<string, EntryHandle>()
  #configuredIds = new Set<string>()
  #transaction = Promise.resolve()

  constructor(context = new RuntimeContext()) {
    this.context = context
  }

  get entries(): readonly EntryHandle[] {
    return [...this.#configuredIds].flatMap((id) => {
      const handle = this.#handles.get(id)
      return handle ? [handle] : []
    })
  }

  entry(id: string): EntryHandle | undefined {
    return this.#configuredIds.has(id) ? this.#handles.get(id) : undefined
  }

  reconcile(manifest: readonly ManifestEntry[]): Promise<ReconcileResult> {
    const snapshot = [...manifest]
    const result = this.#transaction.then(() => this.#apply(snapshot))
    this.#transaction = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async dispose(): Promise<void> {
    await this.reconcile([])
  }

  async #apply(manifest: readonly ManifestEntry[]): Promise<ReconcileResult> {
    const desired = this.#normalize(manifest)
    const desiredIds = new Set(desired.keys())
    const desiredMounted = new Set(
      [...desired.values()].filter((entry) => entry.active).map((entry) => entry.id),
    )
    const oldMounted = this.#mountedSnapshot()

    const removed = [...oldMounted.keys()]
      .filter((id) => !desiredMounted.has(id))
      .sort((left, right) => this.#oldDepth(right) - this.#oldDepth(left))
    const updated = [...desiredMounted]
      .filter((id) => {
        const old = oldMounted.get(id)
        const next = desired.get(id)!
        return old !== undefined
          && (old.revision !== next.revision || old.context !== next.context)
      })
      .sort((left, right) => desired.get(left)!.depth - desired.get(right)!.depth)
    const added = [...desiredMounted]
      .filter((id) => !oldMounted.has(id))
      .sort((left, right) => desired.get(left)!.depth - desired.get(right)!.depth)
    const preserved = [...desiredMounted]
      .filter((id) => {
        const old = oldMounted.get(id)
        const next = desired.get(id)!
        return old !== undefined
          && old.revision === next.revision
          && old.context === next.context
      })

    const plugins = await this.#loadChanged(desired, [...updated, ...added])
    const candidate = new Map(oldMounted)
    const newFibers = new Map<string, RuntimeFiber>()
    const retiredOld = new Set<string>()

    try {
      for (const id of [...removed, ...updated]) {
        const old = candidate.get(id)
        if (!old) continue
        await old.fiber.dispose()
        retiredOld.add(id)
        candidate.delete(id)
      }

      for (const id of [...updated, ...added]) {
        const definition = desired.get(id)!
        const plugin = plugins.get(id)!
        const fiber = definition.context.plugin(plugin)
        newFibers.set(id, fiber)
        candidate.set(id, {
          plugin,
          fiber,
          revision: definition.revision,
          context: definition.context,
        })
      }

      await Promise.all([...candidate.values()].map(({ fiber }) => fiber.await()))
    } catch (changeError) {
      const rollbackError = await this.#rollback(oldMounted, newFibers, retiredOld)
      if (rollbackError !== undefined) {
        throw new AggregateError(
          [changeError, rollbackError],
          'manifest reconciliation failed and the last-known-good graph could not be fully restored',
          { cause: changeError },
        )
      }
      throw changeError
    }

    this.#commit(desired, desiredIds, candidate)
    return { added, updated, removed, preserved }
  }

  #normalize(manifest: readonly ManifestEntry[]): Map<string, NormalizedEntry> {
    const byId = new Map<string, ManifestEntry>()
    for (const entry of manifest) {
      if (byId.has(entry.id)) {
        throw new Error(`manifest contains duplicate entry ${JSON.stringify(entry.id)}`)
      }
      byId.set(entry.id, entry)
    }

    const normalized = new Map<string, NormalizedEntry>()
    const visiting = new Set<string>()
    const visit = (id: string): NormalizedEntry => {
      const existing = normalized.get(id)
      if (existing) return existing
      if (visiting.has(id)) {
        throw new Error(`manifest contains a parent cycle at entry ${JSON.stringify(id)}`)
      }

      const entry = byId.get(id)
      if (!entry) throw new Error(`manifest entry ${JSON.stringify(id)} does not exist`)
      visiting.add(id)

      let depth = 0
      let parentActive = true
      if (entry.parentId !== undefined) {
        if (!byId.has(entry.parentId)) {
          throw new Error(
            `manifest entry ${JSON.stringify(id)} references missing parent ${JSON.stringify(entry.parentId)}`,
          )
        }
        const parent = visit(entry.parentId)
        depth = parent.depth + 1
        parentActive = parent.active
      }

      const enabled = entry.enabled !== false
      const normalizedEntry: NormalizedEntry = {
        id,
        parentId: entry.parentId,
        revision: entry.revision,
        enabled,
        context: entry.context ?? this.context,
        load: entry.load,
        depth,
        active: enabled && parentActive,
      }
      visiting.delete(id)
      normalized.set(id, normalizedEntry)
      return normalizedEntry
    }

    for (const id of byId.keys()) visit(id)
    return normalized
  }

  async #loadChanged(
    desired: Map<string, NormalizedEntry>,
    changed: readonly string[],
  ): Promise<Map<string, RuntimePlugin>> {
    const plugins = new Map<string, RuntimePlugin>()
    await Promise.all(changed.map(async (id) => {
      const definition = desired.get(id)!
      const handle = this.#handles.get(id)
      if (
        handle?.plugin
        && handle.revision === definition.revision
        && handle.context === definition.context
      ) {
        plugins.set(id, handle.plugin)
        return
      }
      plugins.set(id, await definition.load())
    }))
    return plugins
  }

  #mountedSnapshot(): Map<string, MountedSnapshot> {
    const mounted = new Map<string, MountedSnapshot>()
    for (const id of this.#configuredIds) {
      const handle = this.#handles.get(id)
      if (
        handle?.fiber
        && handle.plugin
        && handle.revision !== undefined
        && handle.context
      ) {
        mounted.set(id, {
          plugin: handle.plugin,
          fiber: handle.fiber,
          revision: handle.revision,
          context: handle.context,
        })
      }
    }
    return mounted
  }

  async #rollback(
    oldMounted: Map<string, MountedSnapshot>,
    newFibers: Map<string, RuntimeFiber>,
    retiredOld: Set<string>,
  ): Promise<unknown | undefined> {
    const errors: unknown[] = []
    for (const fiber of [...newFibers.values()].toReversed()) {
      try {
        await fiber.dispose()
      } catch (error) {
        errors.push(error)
      }
    }

    const restored = new Map<string, RuntimeFiber>()
    const restoreIds = [...retiredOld]
      .sort((left, right) => this.#oldDepth(left) - this.#oldDepth(right))
    for (const id of restoreIds) {
      const old = oldMounted.get(id)
      if (!old) continue
      try {
        restored.set(id, old.context.plugin(old.plugin))
      } catch (error) {
        errors.push(error)
      }
    }

    try {
      await Promise.all([
        ...[...oldMounted.entries()]
          .filter(([id]) => !retiredOld.has(id))
          .map(([, { fiber }]) => fiber.await()),
        ...[...restored.values()].map((fiber) => fiber.await()),
      ])
    } catch (error) {
      errors.push(error)
    }

    for (const [id, fiber] of restored) {
      const handle = this.#handles.get(id)
      if (handle) handle.fiber = fiber
    }

    if (errors.length === 1) return errors[0]
    if (errors.length > 1) {
      return new AggregateError(errors, 'rollback reported one or more errors')
    }
    return undefined
  }

  #commit(
    desired: Map<string, NormalizedEntry>,
    desiredIds: Set<string>,
    mounted: Map<string, MountedSnapshot>,
  ): void {
    for (const [id, definition] of desired) {
      let handle = this.#handles.get(id)
      if (!handle) {
        handle = new EntryHandle(id)
        this.#handles.set(id, handle)
      }

      const previousRevision = handle.revision
      const previousContext = handle.context
      handle.parentId = definition.parentId
      handle.revision = definition.revision
      handle.enabled = definition.enabled
      handle.context = definition.context
      if (definition.active) {
        const current = mounted.get(id)!
        handle.plugin = current.plugin
        handle.fiber = current.fiber
      } else {
        if (
          previousRevision !== definition.revision
          || previousContext !== definition.context
        ) handle.plugin = undefined
        handle.fiber = undefined
      }
    }

    for (const id of this.#configuredIds) {
      if (desiredIds.has(id)) continue
      const handle = this.#handles.get(id)
      if (handle) {
        handle.enabled = false
        handle.fiber = undefined
      }
    }
    this.#configuredIds = desiredIds
  }

  #oldDepth(id: string): number {
    let depth = 0
    let current = this.#handles.get(id)
    const visited = new Set<string>()
    while (current?.parentId !== undefined && !visited.has(current.id)) {
      visited.add(current.id)
      depth += 1
      current = this.#handles.get(current.parentId)
    }
    return depth
  }
}
