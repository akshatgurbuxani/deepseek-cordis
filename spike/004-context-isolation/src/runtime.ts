import {
  type Disposer,
  type EffectSetup,
  EffectStack,
} from '../../001-effect-stack/src/effect-stack.ts'

declare const serviceType: unique symbol
const realmConstructorToken = Symbol('realm constructor')

export interface ServiceKey<T> {
  readonly name: string
  readonly token: symbol
  readonly [serviceType]?: T
}

type AnyServiceKey = ServiceKey<unknown>

export function service<T>(name: string): ServiceKey<T> {
  return Object.freeze({ name, token: Symbol(name) })
}

export type Provision<T = unknown> = readonly [ServiceKey<T>, T]

export interface RealmOptions {
  readonly isolate?: readonly AnyServiceKey[]
}

export interface ServiceAccess<T> {
  readonly value: T
  readonly key: ServiceKey<T>
  readonly consumer: Fiber
  readonly provider: Fiber
  readonly realm: Realm
}

export type Interceptor<T> = (access: ServiceAccess<T>) => T

interface InterceptorEntry {
  interceptor: Interceptor<unknown>
  disposed: boolean
}

export interface InterceptorRegistration<T> {
  update(interceptor: Interceptor<T>): void
  dispose(): void
}

/** The lifecycle identity used for one key inside one isolation boundary. */
export class ProviderSlot {
  readonly realm: Realm
  readonly key: AnyServiceKey

  constructor(realm: Realm, key: AnyServiceKey) {
    this.realm = realm
    this.key = key
  }
}

/** A derived dependency namespace with live, inherited access interception. */
export class Realm {
  readonly runtime: Runtime
  readonly parent: Realm | undefined
  readonly #isolated: Set<AnyServiceKey>
  readonly #slots = new Map<AnyServiceKey, ProviderSlot>()
  readonly #interceptors = new Map<AnyServiceKey, InterceptorEntry[]>()

  constructor(
    runtime: Runtime,
    parent: Realm | undefined,
    options: RealmOptions = {},
    token?: symbol,
  ) {
    if (token !== realmConstructorToken) {
      throw new Error('realms must be created by a runtime or derived realm')
    }
    if (parent && parent.runtime !== runtime) {
      throw new Error('a realm parent must belong to the same runtime')
    }
    this.runtime = runtime
    this.parent = parent
    this.#isolated = new Set(options.isolate ?? [])
  }

  derive(options: RealmOptions = {}): Realm {
    return new Realm(this.runtime, this, options, realmConstructorToken)
  }

  slotFor(key: AnyServiceKey): ProviderSlot {
    let current: Realm = this
    while (current.parent && !current.#isolated.has(key)) {
      current = current.parent
    }
    return current.#slot(key)
  }

  intercept<T>(key: ServiceKey<T>, interceptor: Interceptor<T>): InterceptorRegistration<T> {
    const entry: InterceptorEntry = {
      interceptor: interceptor as Interceptor<unknown>,
      disposed: false,
    }
    const entries = this.#interceptors.get(key) ?? []
    entries.push(entry)
    this.#interceptors.set(key, entries)

    return {
      update(next: Interceptor<T>): void {
        if (entry.disposed) throw new Error('cannot update a disposed interceptor')
        entry.interceptor = next as Interceptor<unknown>
      },
      dispose: (): void => {
        if (entry.disposed) return
        entry.disposed = true
        const index = entries.indexOf(entry)
        if (index !== -1) entries.splice(index, 1)
        if (entries.length === 0) this.#interceptors.delete(key)
      },
    }
  }

  interceptorsFor(key: AnyServiceKey): readonly Interceptor<unknown>[] {
    const lineage: Realm[] = []
    for (let current: Realm | undefined = this; current; current = current.parent) {
      lineage.push(current)
    }

    return lineage
      .reverse()
      .flatMap((realm) =>
        (realm.#interceptors.get(key) ?? [])
          .filter((entry) => !entry.disposed)
          .map((entry) => entry.interceptor),
      )
  }

  #slot(key: AnyServiceKey): ProviderSlot {
    let slot = this.#slots.get(key)
    if (!slot) {
      slot = new ProviderSlot(this, key)
      this.#slots.set(key, slot)
    }
    return slot
  }
}

export interface Component {
  readonly name: string
  readonly realm?: Realm
  readonly requires?: readonly AnyServiceKey[]
  readonly provides?: readonly Provision[]
  readonly setup: (context: Context) => unknown | Promise<unknown>
}

export interface Context {
  get<T>(key: ServiceKey<T>): T
  effect(setup: EffectSetup): Promise<Disposer>
}

export type FiberState = 'pending' | 'activating' | 'active' | 'disposing' | 'disposed'

type DesiredState = 'registered' | 'disposed'

interface ProviderBinding {
  fiber: Fiber
  value: unknown
  slot: ProviderSlot
}

interface ActivationTarget {
  desiredRevision: number
  providers: Map<AnyServiceKey, ProviderBinding>
}

export class Fiber {
  readonly component: Component
  readonly realm: Realm
  state: FiberState = 'pending'
  desired: DesiredState = 'registered'
  desiredRevision: number
  committedRevision: number | undefined
  lastError?: unknown

  /** The exact provider identities used by the current activation. */
  committed = new Map<AnyServiceKey, ProviderBinding>()
  scope: EffectStack | undefined
  transition: Promise<void> | undefined
  failedTarget: ActivationTarget | undefined

  constructor(component: Component, realm: Realm, desiredRevision: number) {
    this.component = component
    this.realm = realm
    this.desiredRevision = desiredRevision
  }

  get name(): string {
    return this.component.name
  }
}

export class Runtime {
  readonly #fibers: Fiber[] = []
  readonly #published = new Map<ProviderSlot, ProviderBinding>()
  readonly #errors: unknown[] = []
  readonly #inflight = new Set<Promise<void>>()
  #revision = 0
  #dirty = false
  #runner: Promise<void> | undefined
  readonly root: Realm

  constructor() {
    this.root = new Realm(this, undefined, {}, realmConstructorToken)
  }

  get revision(): number {
    return this.#revision
  }

  get fibers(): readonly Fiber[] {
    return this.#fibers
  }

  get<T>(key: ServiceKey<T>, realm: Realm = this.root): T | undefined {
    this.#assertRealm(realm)
    return this.#published.get(realm.slotFor(key))?.value as T | undefined
  }

  add(component: Component): Fiber {
    this.#assertProvisionsAvailable(component)
    const revision = this.#nextRevision()
    const realm = component.realm ?? this.root
    const fiber = new Fiber(component, realm, revision)
    this.#fibers.push(fiber)
    this.#schedule()
    return fiber
  }

  remove(fiber: Fiber): void {
    if (fiber.desired === 'disposed') return
    this.#assertOwned(fiber)

    fiber.desired = 'disposed'
    fiber.desiredRevision = this.#nextRevision()
    this.#withdrawCascade(fiber, new Set(), fiber.desiredRevision)
    this.#schedule()
  }

  replace(previous: Fiber, component: Component): Fiber {
    if (previous.desired === 'disposed') {
      throw new Error(`fiber ${JSON.stringify(previous.name)} is already removed`)
    }
    this.#assertOwned(previous)
    this.#assertProvisionsAvailable(component, previous)

    const revision = this.#nextRevision()
    previous.desired = 'disposed'
    previous.desiredRevision = revision
    this.#withdrawCascade(previous, new Set(), revision)

    const realm = component.realm ?? this.root
    const replacement = new Fiber(component, realm, revision)
    this.#fibers.push(replacement)
    this.#schedule()
    return replacement
  }

  async settle(): Promise<void> {
    while (true) {
      if (this.#runner) {
        await this.#runner
        continue
      }
      if (this.#inflight.size > 0) {
        await Promise.race(
          [...this.#inflight].map((transition) => transition.catch(() => undefined)),
        )
        continue
      }
      if (this.#dirty) {
        this.#schedule()
        continue
      }
      break
    }

    const errors = this.#errors.splice(0)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'one or more lifecycle transitions failed')
    }
  }

  #nextRevision(): number {
    this.#revision += 1
    return this.#revision
  }

  #schedule(): void {
    this.#dirty = true
    if (this.#runner) return

    const runner = this.#drain().finally(() => {
      if (this.#runner === runner) this.#runner = undefined
      if (this.#dirty) this.#schedule()
    })
    this.#runner = runner
  }

  async #drain(): Promise<void> {
    do {
      this.#dirty = false
      this.#finalizePendingRemovals()

      const inactive = this.#inactiveRoots().map((fiber) => this.#driveInactive(fiber))
      const active = this.#fibers
        .filter((fiber) => this.#canActivate(fiber))
        .map((fiber) => this.#driveActive(fiber))
      const transitions = [...inactive, ...active]
      for (const transition of transitions) this.#track(transition)
    } while (this.#dirty)
  }

  #track(transition: Promise<void>): void {
    if (this.#inflight.has(transition)) return
    this.#inflight.add(transition)
    void transition
      .catch((error: unknown) => {
        this.#errors.push(error)
      })
      .finally(() => {
        this.#inflight.delete(transition)
        this.#schedule()
      })
  }

  #finalizePendingRemovals(): void {
    for (const fiber of [...this.#fibers]) {
      if (fiber.desired === 'disposed' && fiber.state === 'pending' && !fiber.transition)
        this.#finalizeDisposed(fiber)
    }
  }

  #inactiveRoots(): Fiber[] {
    const invalid = this.#fibers.filter((fiber) => this.#needsDeactivation(fiber))
    const invalidSet = new Set(invalid)
    return invalid.filter(
      (fiber) => ![...fiber.committed.values()].some((binding) => invalidSet.has(binding.fiber)),
    )
  }

  #needsDeactivation(fiber: Fiber): boolean {
    if (fiber.state !== 'active') return false
    if (fiber.desired === 'disposed') return true
    return [...fiber.committed.values()].some(
      (binding) => this.#published.get(binding.slot) !== binding,
    )
  }

  #canActivate(fiber: Fiber): boolean {
    if (
      fiber.state !== 'pending' ||
      fiber.desired !== 'registered' ||
      fiber.transition ||
      this.#hasRetiringProvider(fiber)
    )
      return false

    const target = this.#snapshotTarget(fiber)
    return target !== undefined && !this.#sameTarget(target, fiber.failedTarget)
  }

  #hasRetiringProvider(fiber: Fiber): boolean {
    return (fiber.component.provides ?? []).some(([key]) => {
      const slot = fiber.realm.slotFor(key)
      return this.#fibers.some(
        (candidate) =>
          candidate !== fiber &&
          candidate.desired === 'disposed' &&
          candidate.state !== 'disposed' &&
          (candidate.component.provides ?? []).some(
            ([provided]) => candidate.realm.slotFor(provided) === slot,
          ),
      )
    })
  }

  #snapshotTarget(fiber: Fiber): ActivationTarget | undefined {
    const providers = new Map<AnyServiceKey, ProviderBinding>()
    for (const key of fiber.component.requires ?? []) {
      const binding = this.#published.get(fiber.realm.slotFor(key))
      if (binding?.fiber.desired !== 'registered') return undefined
      providers.set(key, binding)
    }
    return { desiredRevision: fiber.desiredRevision, providers }
  }

  #sameTarget(first: ActivationTarget | undefined, second: ActivationTarget | undefined): boolean {
    if (!first || !second) return false
    if (
      first.desiredRevision !== second.desiredRevision ||
      first.providers.size !== second.providers.size
    )
      return false

    return [...first.providers].every(([key, binding]) => second.providers.get(key) === binding)
  }

  async #driveActive(fiber: Fiber): Promise<void> {
    while (fiber.transition) {
      try {
        await fiber.transition
      } catch {
        // The transition records its own error and leaves a stable state.
      }
    }
    if (!this.#canActivate(fiber)) return

    const target = this.#snapshotTarget(fiber)
    if (!target) return
    const transition = this.#activate(fiber, target)
    fiber.transition = transition
    try {
      await transition
    } finally {
      if (fiber.transition === transition) fiber.transition = undefined
      this.#dirty = true
    }
  }

  async #activate(fiber: Fiber, target: ActivationTarget): Promise<void> {
    const scope = new EffectStack()
    fiber.state = 'activating'
    fiber.scope = scope
    fiber.committed = new Map(target.providers)
    fiber.lastError = undefined

    const context: Context = {
      get: <T>(key: ServiceKey<T>): T => this.#readCommitted(fiber, key),
      effect(setup: EffectSetup): Promise<Disposer> {
        return scope.effect(setup)
      },
    }

    try {
      await fiber.component.setup(context)
    } catch (setupError) {
      fiber.failedTarget = target
      fiber.lastError = setupError
      const rollbackError = await this.#recoverActivation(fiber, scope)
      if (rollbackError !== undefined) {
        throw new AggregateError(
          [setupError, rollbackError],
          `component ${JSON.stringify(fiber.name)} failed to activate and roll back`,
          { cause: setupError },
        )
      }
      throw setupError
    }

    if (!this.#targetIsCurrent(fiber, target)) {
      const rollbackError = await this.#recoverActivation(fiber, scope)
      if (rollbackError !== undefined) throw rollbackError
      return
    }

    fiber.state = 'active'
    fiber.committedRevision = target.desiredRevision
    fiber.failedTarget = undefined
    for (const [key, value] of fiber.component.provides ?? []) {
      const slot = fiber.realm.slotFor(key)
      this.#published.set(slot, { fiber, value, slot })
    }
  }

  #targetIsCurrent(fiber: Fiber, target: ActivationTarget): boolean {
    if (fiber.desired !== 'registered' || fiber.desiredRevision !== target.desiredRevision)
      return false

    return [...target.providers].every(
      ([, binding]) => this.#published.get(binding.slot) === binding,
    )
  }

  #readCommitted<T>(fiber: Fiber, key: ServiceKey<T>): T {
    const binding = fiber.committed.get(key)
    if (!binding) {
      throw new Error(
        `component ${JSON.stringify(fiber.name)} did not declare and commit service ${JSON.stringify(key.name)}`,
      )
    }

    let value: unknown = binding.value
    for (const interceptor of fiber.realm.interceptorsFor(key)) {
      value = interceptor({
        value,
        key: key as ServiceKey<unknown>,
        consumer: fiber,
        provider: binding.fiber,
        realm: fiber.realm,
      })
    }
    return value as T
  }

  async #recoverActivation(fiber: Fiber, scope: EffectStack): Promise<unknown | undefined> {
    let rollbackError: unknown | undefined
    try {
      await scope.dispose()
    } catch (error) {
      rollbackError = error
      fiber.lastError = error
    } finally {
      fiber.committed.clear()
      fiber.committedRevision = undefined
      fiber.scope = undefined
      if (fiber.desired === 'disposed') {
        this.#finalizeDisposed(fiber)
      } else {
        fiber.state = 'pending'
      }
    }
    return rollbackError
  }

  async #driveInactive(fiber: Fiber): Promise<void> {
    while (fiber.transition) {
      try {
        await fiber.transition
      } catch {
        // Continue toward the newest desired state after failed old work.
      }
    }

    if (fiber.state === 'pending') {
      if (fiber.desired === 'disposed') this.#finalizeDisposed(fiber)
      return
    }
    if (fiber.state !== 'active') return

    const transition = this.#deactivate(fiber)
    fiber.transition = transition
    try {
      await transition
    } finally {
      if (fiber.transition === transition) fiber.transition = undefined
      this.#dirty = true
    }
  }

  async #deactivate(fiber: Fiber): Promise<void> {
    fiber.state = 'disposing'
    this.#withdrawCascade(fiber)

    const errors: unknown[] = []
    const dependents = [...this.#fibers]
      .reverse()
      .filter(
        (candidate) =>
          (candidate.state === 'activating' ||
            candidate.state === 'active' ||
            candidate.state === 'disposing') &&
          [...candidate.committed.values()].some((binding) => binding.fiber === fiber),
      )
    const results = await Promise.allSettled(
      dependents.map((dependent) => this.#driveInactive(dependent)),
    )
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason)
    }

    try {
      await fiber.scope?.dispose()
    } catch (error) {
      errors.push(error)
    } finally {
      fiber.committed.clear()
      fiber.committedRevision = undefined
      fiber.scope = undefined
      if (fiber.desired === 'disposed') {
        this.#finalizeDisposed(fiber)
      } else {
        fiber.state = 'pending'
      }
    }

    if (errors.length === 1) {
      fiber.lastError = errors[0]
      throw errors[0]
    }
    if (errors.length > 1) {
      const error = new AggregateError(
        errors,
        `component ${JSON.stringify(fiber.name)} and its consumers failed to dispose`,
      )
      fiber.lastError = error
      throw error
    }
  }

  #withdrawCascade(fiber: Fiber, visited = new Set<Fiber>(), desiredRevision?: number): void {
    if (visited.has(fiber)) return
    visited.add(fiber)

    for (const [slot, binding] of this.#published) {
      if (binding.fiber === fiber) this.#published.delete(slot)
    }
    for (const candidate of this.#fibers) {
      if (
        (candidate.state === 'active' || candidate.state === 'activating') &&
        [...candidate.committed.values()].some((binding) => binding.fiber === fiber)
      ) {
        if (desiredRevision !== undefined && candidate.desired === 'registered') {
          candidate.desiredRevision = desiredRevision
        }
        this.#withdrawCascade(candidate, visited, desiredRevision)
      }
    }
  }

  #finalizeDisposed(fiber: Fiber): void {
    this.#withdrawCascade(fiber)
    fiber.committed.clear()
    fiber.committedRevision = undefined
    fiber.scope = undefined
    fiber.state = 'disposed'
    const index = this.#fibers.indexOf(fiber)
    if (index !== -1) this.#fibers.splice(index, 1)
  }

  #assertOwned(fiber: Fiber): void {
    if (!this.#fibers.includes(fiber)) {
      throw new Error(`fiber ${JSON.stringify(fiber.name)} does not belong to this runtime`)
    }
  }

  #assertProvisionsAvailable(component: Component, ignored?: Fiber): void {
    const realm = component.realm ?? this.root
    this.#assertRealm(realm)
    const ownSlots = new Set<ProviderSlot>()
    for (const [key] of component.provides ?? []) {
      const slot = realm.slotFor(key)
      if (ownSlots.has(slot)) {
        throw new Error(
          `component ${JSON.stringify(component.name)} provides service ${JSON.stringify(key.name)} more than once`,
        )
      }
      ownSlots.add(slot)

      const owner = this.#fibers.find(
        (fiber) =>
          fiber !== ignored &&
          fiber.desired !== 'disposed' &&
          (fiber.component.provides ?? []).some(
            ([provided]) => fiber.realm.slotFor(provided) === slot,
          ),
      )
      if (owner) {
        throw new Error(
          `service ${JSON.stringify(key.name)} is already provided by component ${JSON.stringify(owner.name)}`,
        )
      }
    }
  }

  #assertRealm(realm: Realm): void {
    if (realm.runtime !== this) {
      throw new Error('realm does not belong to this runtime')
    }
  }
}
