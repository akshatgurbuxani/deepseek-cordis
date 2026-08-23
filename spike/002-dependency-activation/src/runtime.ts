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

export type FiberState = 'pending' | 'active' | 'disposed'

interface ProviderBinding {
  fiber: Fiber
  value: unknown
}

export class Fiber {
  state: FiberState = 'pending'
  lastError?: unknown
  readonly component: Component

  /** The exact provider identities used by the current activation. */
  committed = new Map<AnyServiceKey, ProviderBinding>()
  scope: EffectStack | undefined

  constructor(component: Component) {
    this.component = component
  }

  get name(): string {
    return this.component.name
  }
}

export class Runtime {
  readonly #fibers: Fiber[] = []
  readonly #published = new Map<AnyServiceKey, ProviderBinding>()
  #mutation = Promise.resolve()

  get fibers(): readonly Fiber[] {
    return this.#fibers
  }

  get<T>(key: ServiceKey<T>): T | undefined {
    return this.#published.get(key)?.value as T | undefined
  }

  add(component: Component): Promise<Fiber> {
    return this.#enqueue(async () => {
      this.#assertProvisionsAvailable(component)
      const fiber = new Fiber(component)
      this.#fibers.push(fiber)
      await this.#reconcile()
      return fiber
    })
  }

  remove(fiber: Fiber): Promise<void> {
    return this.#enqueue(async () => {
      if (fiber.state === 'disposed') return
      if (!this.#fibers.includes(fiber)) {
        throw new Error(`fiber ${JSON.stringify(fiber.name)} does not belong to this runtime`)
      }

      const errors: unknown[] = []
      await this.#deactivateTree(fiber, 'disposed', errors, new Set())
      const index = this.#fibers.indexOf(fiber)
      if (index !== -1) this.#fibers.splice(index, 1)

      try {
        await this.#reconcile()
      } catch (error) {
        errors.push(error)
      }
      this.#throwErrors(errors, `removing component ${JSON.stringify(fiber.name)} failed`)
    })
  }

  replace(previous: Fiber, component: Component): Promise<Fiber> {
    return this.#enqueue(async () => {
      if (previous.state === 'disposed' || !this.#fibers.includes(previous)) {
        throw new Error(`fiber ${JSON.stringify(previous.name)} does not belong to this runtime`)
      }
      this.#assertProvisionsAvailable(component, previous)

      const errors: unknown[] = []
      await this.#deactivateTree(previous, 'disposed', errors, new Set())
      const index = this.#fibers.indexOf(previous)
      if (index !== -1) this.#fibers.splice(index, 1)

      const replacement = new Fiber(component)
      this.#fibers.push(replacement)
      try {
        await this.#reconcile()
      } catch (error) {
        errors.push(error)
      }
      this.#throwErrors(errors, `replacing component ${JSON.stringify(previous.name)} failed`)
      return replacement
    })
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation)
    this.#mutation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #reconcile(): Promise<void> {
    const attempted = new Set<Fiber>()
    const errors: unknown[] = []
    let changed: boolean

    do {
      changed = false
      for (const fiber of this.#fibers) {
        if (
          fiber.state !== 'pending' ||
          attempted.has(fiber) ||
          !this.#isEligible(fiber)
        ) continue

        attempted.add(fiber)
        try {
          await this.#activate(fiber)
          changed = true
        } catch (error) {
          fiber.lastError = error
          errors.push(error)
        }
      }
    } while (changed)

    this.#throwErrors(errors, 'one or more components failed to activate')
  }

  #isEligible(fiber: Fiber): boolean {
    return (fiber.component.requires ?? []).every((key) => this.#published.has(key))
  }

  async #activate(fiber: Fiber): Promise<void> {
    const committed = new Map<AnyServiceKey, ProviderBinding>()
    for (const key of fiber.component.requires ?? []) {
      const binding = this.#published.get(key)
      if (!binding) return
      committed.set(key, binding)
    }

    const scope = new EffectStack()
    fiber.committed = committed
    fiber.scope = scope
    fiber.lastError = undefined

    const context: Context = {
      get<T>(key: ServiceKey<T>): T {
        const binding = committed.get(key)
        if (!binding) {
          throw new Error(`component ${JSON.stringify(fiber.name)} did not commit service ${JSON.stringify(key.name)}`)
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
      fiber.lastError = setupError
      try {
        await scope.dispose()
      } catch (rollbackError) {
        fiber.committed.clear()
        fiber.scope = undefined
        throw new AggregateError(
          [setupError, rollbackError],
          `component ${JSON.stringify(fiber.name)} failed to activate and roll back`,
          { cause: setupError },
        )
      }
      fiber.committed.clear()
      fiber.scope = undefined
      throw setupError
    }

    fiber.state = 'active'
    for (const [key, value] of fiber.component.provides ?? []) {
      this.#published.set(key, { fiber, value })
    }
  }

  async #deactivateTree(
    fiber: Fiber,
    finalState: 'pending' | 'disposed',
    errors: unknown[],
    visited: Set<Fiber>,
  ): Promise<void> {
    if (visited.has(fiber)) return
    visited.add(fiber)

    if (fiber.state === 'active') {
      this.#withdraw(fiber)
      const dependents = [...this.#fibers]
        .reverse()
        .filter((candidate) =>
          candidate.state === 'active' &&
          [...candidate.committed.values()].some((binding) => binding.fiber === fiber),
        )
      for (const dependent of dependents) {
        await this.#deactivateTree(dependent, 'pending', errors, visited)
      }

      try {
        await fiber.scope?.dispose()
      } catch (error) {
        errors.push(error)
      } finally {
        fiber.committed.clear()
        fiber.scope = undefined
      }
    }

    fiber.state = finalState
  }

  #withdraw(fiber: Fiber): void {
    for (const [key, binding] of this.#published) {
      if (binding.fiber === fiber) this.#published.delete(key)
    }
  }

  #assertProvisionsAvailable(component: Component, ignored?: Fiber): void {
    const ownKeys = new Set<AnyServiceKey>()
    for (const [key] of component.provides ?? []) {
      if (ownKeys.has(key)) {
        throw new Error(`component ${JSON.stringify(component.name)} provides service ${JSON.stringify(key.name)} more than once`)
      }
      ownKeys.add(key)

      const owner = this.#fibers.find((fiber) =>
        fiber !== ignored &&
        fiber.state !== 'disposed' &&
        (fiber.component.provides ?? []).some(([provided]) => provided === key),
      )
      if (owner) {
        throw new Error(
          `service ${JSON.stringify(key.name)} is already provided by component ${JSON.stringify(owner.name)}`,
        )
      }
    }
  }

  #throwErrors(errors: unknown[], message: string): void {
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, message)
  }
}
