import {
  type Component,
  type Fiber,
  Runtime,
} from '../../004-context-isolation/src/runtime.ts'

export interface ManifestEntry {
  readonly id: string
  readonly parentId?: string
  readonly revision: string
  readonly enabled?: boolean
  readonly load: () => Component | Promise<Component>
}

interface NormalizedEntry {
  id: string
  parentId: string | undefined
  revision: string
  enabled: boolean
  load: () => Component | Promise<Component>
  depth: number
  active: boolean
}

interface ActiveSnapshot {
  component: Component
  fiber: Fiber
  revision: string
}

export class EntryHandle {
  readonly id: string
  parentId: string | undefined
  revision: string | undefined
  enabled = false
  component: Component | undefined
  fiber: Fiber | undefined

  constructor(id: string) {
    this.id = id
  }

  get active(): boolean {
    return this.fiber?.state === 'active'
  }
}

export interface ReconcileResult {
  readonly added: readonly string[]
  readonly updated: readonly string[]
  readonly removed: readonly string[]
  readonly preserved: readonly string[]
}

/** A declarative, last-known-good configuration layer over the lifecycle runtime. */
export class DeclarativeHost {
  readonly runtime: Runtime
  readonly #handles = new Map<string, EntryHandle>()
  #configuredIds = new Set<string>()
  #transaction = Promise.resolve()

  constructor(runtime = new Runtime()) {
    this.runtime = runtime
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

  async #apply(manifest: readonly ManifestEntry[]): Promise<ReconcileResult> {
    const desired = this.#normalize(manifest)
    const desiredIds = new Set(desired.keys())
    const desiredActive = new Set(
      [...desired.values()].filter((entry) => entry.active).map((entry) => entry.id),
    )
    const oldActive = this.#activeSnapshot()

    const removed = [...oldActive.keys()]
      .filter((id) => !desiredActive.has(id))
      .sort((left, right) => this.#oldDepth(right) - this.#oldDepth(left))
    const updated = [...desiredActive]
      .filter((id) => {
        const old = oldActive.get(id)
        return old !== undefined && old.revision !== desired.get(id)?.revision
      })
      .sort((left, right) => desired.get(left)!.depth - desired.get(right)!.depth)
    const added = [...desiredActive]
      .filter((id) => !oldActive.has(id))
      .sort((left, right) => desired.get(left)!.depth - desired.get(right)!.depth)
    const preserved = [...desiredActive]
      .filter((id) => oldActive.get(id)?.revision === desired.get(id)?.revision)

    const components = await this.#loadChanged(desired, desiredActive)
    const candidate = new Map(oldActive)
    const newFibers = new Set<Fiber>()
    const retiredOld = new Set<string>()

    try {
      for (const id of removed) {
        const old = candidate.get(id)
        if (old) {
          this.runtime.remove(old.fiber)
          retiredOld.add(id)
        }
        candidate.delete(id)
      }

      for (const id of [...updated, ...added]) {
        const definition = desired.get(id)!
        const component = components.get(id)!
        const old = candidate.get(id)
        const fiber = old
          ? this.runtime.replace(old.fiber, component)
          : this.runtime.add(component)
        if (old) retiredOld.add(id)
        newFibers.add(fiber)
        candidate.set(id, { component, fiber, revision: definition.revision })
      }

      await this.runtime.settle()
    } catch (changeError) {
      const rollbackError = await this.#rollback(oldActive, newFibers, retiredOld)
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
      const value: NormalizedEntry = {
        id,
        parentId: entry.parentId,
        revision: entry.revision,
        enabled,
        load: entry.load,
        depth,
        active: enabled && parentActive,
      }
      visiting.delete(id)
      normalized.set(id, value)
      return value
    }

    for (const id of byId.keys()) visit(id)
    return normalized
  }

  async #loadChanged(
    desired: Map<string, NormalizedEntry>,
    desiredActive: Set<string>,
  ): Promise<Map<string, Component>> {
    const components = new Map<string, Component>()
    await Promise.all([...desiredActive].map(async (id) => {
      const definition = desired.get(id)!
      const handle = this.#handles.get(id)
      if (handle?.component && handle.revision === definition.revision) {
        components.set(id, handle.component)
        return
      }
      components.set(id, await definition.load())
    }))
    return components
  }

  #activeSnapshot(): Map<string, ActiveSnapshot> {
    const active = new Map<string, ActiveSnapshot>()
    for (const id of this.#configuredIds) {
      const handle = this.#handles.get(id)
      if (handle?.fiber && handle.component && handle.revision !== undefined) {
        active.set(id, {
          component: handle.component,
          fiber: handle.fiber,
          revision: handle.revision,
        })
      }
    }
    return active
  }

  async #rollback(
    oldActive: Map<string, ActiveSnapshot>,
    newFibers: Set<Fiber>,
    retiredOld: Set<string>,
  ): Promise<unknown | undefined> {
    const errors: unknown[] = []
    for (const fiber of newFibers) {
      try {
        this.runtime.remove(fiber)
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await this.runtime.settle()
    } catch (error) {
      errors.push(error)
    }

    const restored = new Map<string, Fiber>()
    for (const id of retiredOld) {
      const old = oldActive.get(id)
      if (!old) continue
      try {
        restored.set(id, this.runtime.add(old.component))
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await this.runtime.settle()
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
    active: Map<string, ActiveSnapshot>,
  ): void {
    for (const [id, definition] of desired) {
      let handle = this.#handles.get(id)
      if (!handle) {
        handle = new EntryHandle(id)
        this.#handles.set(id, handle)
      }

      const previousRevision = handle.revision
      handle.parentId = definition.parentId
      handle.revision = definition.revision
      handle.enabled = definition.enabled
      if (definition.active) {
        const current = active.get(id)!
        handle.component = current.component
        handle.fiber = current.fiber
      } else {
        if (previousRevision !== definition.revision) handle.component = undefined
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

export type { Component, Fiber }
export { Runtime }
