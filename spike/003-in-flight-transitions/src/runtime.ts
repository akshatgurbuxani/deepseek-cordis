import {
  EffectStack,
  type Disposer,
  type EffectSetup,
} from '../../001-effect-stack/src/effect-stack.ts'

declare const serviceType: unique symbol

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

export interface Component {
  readonly name: string
  readonly requires?: readonly AnyServiceKey[]
  readonly provides?: readonly Provision[]
  readonly setup: (context: Context) => unknown | Promise<unknown>
}

export interface Context {
  get<T>(key: ServiceKey<T>): T
  effect(setup: EffectSetup): Promise<Disposer>
}

export type FiberState =
  | 'pending'
  | 'activating'
  | 'active'
  | 'disposing'
  | 'disposed'

type DesiredState = 'registered' | 'disposed'

interface ProviderBinding {
  fiber: Fiber
  value: unknown
}

interface ActivationTarget {
  desiredRevision: number
  providers: Map<AnyServiceKey, ProviderBinding>
}

export class Fiber {
  readonly component: Component
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

  constructor(component: Component, desiredRevision: number) {
    this.component = component
    this.desiredRevision = desiredRevision
  }

  get name(): string {
    return this.component.name
  }
}

export class Runtime {
  readonly #fibers: Fiber[] = []
  readonly #published = new Map<AnyServiceKey, ProviderBinding>()
  readonly #errors: unknown[] = []
  readonly #inflight = new Set<Promise<void>>()
  #revision = 0
  #dirty = false
  #runner: Promise<void> | undefined

  get revision(): number {
    return this.#revision
  }

  get fibers(): readonly Fiber[] {
    return this.#fibers
  }

  get<T>(key: ServiceKey<T>): T | undefined {
    return this.#published.get(key)?.value as T | undefined
  }

  add(component: Component): Fiber {
    this.#assertProvisionsAvailable(component)
    const revision = this.#nextRevision()
    const fiber = new Fiber(component, revision)
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

    const replacement = new Fiber(component, revision)
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

      const inactive = this.#inactiveRoots().map((fiber) =>
        this.#driveInactive(fiber),
      )
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
      if (
        fiber.desired === 'disposed' &&
        fiber.state === 'pending' &&
        !fiber.transition
      ) this.#finalizeDisposed(fiber)
    }
  }

  #inactiveRoots(): Fiber[] {
    const invalid = this.#fibers.filter((fiber) => this.#needsDeactivation(fiber))
    const invalidSet = new Set(invalid)
    return invalid.filter((fiber) =>
      ![...fiber.committed.values()].some((binding) => invalidSet.has(binding.fiber)),
    )
  }

  #needsDeactivation(fiber: Fiber): boolean {
    if (fiber.state !== 'active') return false
    if (fiber.desired === 'disposed') return true
    return [...fiber.committed].some(
      ([key, binding]) => this.#published.get(key) !== binding,
    )
  }

  #canActivate(fiber: Fiber): boolean {
    if (
      fiber.state !== 'pending' ||
      fiber.desired !== 'registered' ||
      fiber.transition ||
      this.#hasRetiringProvider(fiber)
    ) return false

    const target = this.#snapshotTarget(fiber)
    return target !== undefined && !this.#sameTarget(target, fiber.failedTarget)
  }

  #hasRetiringProvider(fiber: Fiber): boolean {
    return (fiber.component.provides ?? []).some(([key]) =>
      this.#fibers.some((candidate) =>
        candidate !== fiber &&
        candidate.desired === 'disposed' &&
        candidate.state !== 'disposed' &&
        (candidate.component.provides ?? []).some(([provided]) => provided === key),
      ),
    )
  }

  #snapshotTarget(fiber: Fiber): ActivationTarget | undefined {
    const providers = new Map<AnyServiceKey, ProviderBinding>()
    for (const key of fiber.component.requires ?? []) {
      const binding = this.#published.get(key)
      if (!binding || binding.fiber.desired !== 'registered') return undefined
      providers.set(key, binding)
    }
    return { desiredRevision: fiber.desiredRevision, providers }
  }

  #sameTarget(
    first: ActivationTarget | undefined,
    second: ActivationTarget | undefined,
  ): boolean {
    if (!first || !second) return false
    if (
      first.desiredRevision !== second.desiredRevision ||
      first.providers.size !== second.providers.size
    ) return false

    return [...first.providers].every(
      ([key, binding]) => second.providers.get(key) === binding,
    )
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
      get<T>(key: ServiceKey<T>): T {
        const binding = fiber.committed.get(key)
        if (!binding) {
          throw new Error(
            `component ${JSON.stringify(fiber.name)} did not commit service ${JSON.stringify(key.name)}`,
          )
        }
        return binding.value as T
      },
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
      this.#published.set(key, { fiber, value })
    }
  }

  #targetIsCurrent(fiber: Fiber, target: ActivationTarget): boolean {
    if (
      fiber.desired !== 'registered' ||
      fiber.desiredRevision !== target.desiredRevision
    ) return false

    return [...target.providers].every(
      ([key, binding]) => this.#published.get(key) === binding,
    )
  }

  async #recoverActivation(
    fiber: Fiber,
    scope: EffectStack,
  ): Promise<unknown | undefined> {
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
      .filter((candidate) =>
        (
          candidate.state === 'activating' ||
          candidate.state === 'active' ||
          candidate.state === 'disposing'
        ) &&
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

  #withdrawCascade(
    fiber: Fiber,
    visited = new Set<Fiber>(),
    desiredRevision?: number,
  ): void {
    if (visited.has(fiber)) return
    visited.add(fiber)

    for (const [key, binding] of this.#published) {
      if (binding.fiber === fiber) this.#published.delete(key)
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
    const ownKeys = new Set<AnyServiceKey>()
    for (const [key] of component.provides ?? []) {
      if (ownKeys.has(key)) {
        throw new Error(
          `component ${JSON.stringify(component.name)} provides service ${JSON.stringify(key.name)} more than once`,
        )
      }
      ownKeys.add(key)

      const owner = this.#fibers.find((fiber) =>
        fiber !== ignored &&
        fiber.desired !== 'disposed' &&
        (fiber.component.provides ?? []).some(([provided]) => provided === key),
      )
      if (owner) {
        throw new Error(
          `service ${JSON.stringify(key.name)} is already provided by component ${JSON.stringify(owner.name)}`,
        )
      }
    }
  }
}
