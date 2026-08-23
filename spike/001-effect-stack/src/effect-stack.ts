export type Disposer = () => void | Promise<void>

export type EffectValue =
  | void
  | Disposer
  | Iterable<Disposer>
  | AsyncIterable<Disposer>
export type EffectSetup = () => EffectValue | Promise<EffectValue>

interface EffectRecord {
  disposers: Disposer[]
  setup: Promise<void>
  setupComplete: boolean
  setupFailed: boolean
  setupError?: unknown
  disposal?: Promise<void>
}

export type ScopeState = 'active' | 'disposing' | 'disposed'

function isObject(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function isIterable(value: unknown): value is Iterable<Disposer> {
  return isObject(value) && Symbol.iterator in value
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Disposer> {
  return isObject(value) && Symbol.asyncIterator in value
}

function assertDisposer(value: unknown): asserts value is Disposer {
  if (typeof value !== 'function') {
    throw new TypeError('an effect must produce disposer functions')
  }
}

/**
 * A deliberately small ownership boundary for revertible effects.
 *
 * This is an educational reimplementation of the behavior under study, not
 * copied Cordis runtime code and not yet a component or dependency runtime.
 */
export class EffectStack {
  readonly #records: EffectRecord[] = []
  #state: ScopeState = 'active'
  #disposal?: Promise<void>

  get state(): ScopeState {
    return this.#state
  }

  get size(): number {
    return this.#records.length
  }

  /**
   * Acquire an effect and return its single-shot disposer after setup settles.
   * Iterable setups may yield several completed acquisition steps.
   */
  effect(setup: EffectSetup): Promise<Disposer> {
    this.#assertActive()

    const record: EffectRecord = {
      disposers: [],
      setup: Promise.resolve(),
      setupComplete: false,
      setupFailed: false,
    }
    this.#records.push(record)

    record.setup = this.#collect(record, setup).then(
      () => {
        record.setupComplete = true
      },
      (setupError: unknown) => {
        record.setupComplete = true
        record.setupFailed = true
        record.setupError = setupError
      },
    )

    return record.setup.then(async () => {
      if (record.setupFailed) {
        try {
          await this.#disposeRecord(record)
        } catch (rollbackError) {
          throw new AggregateError(
            [record.setupError, rollbackError],
            'effect setup failed and rollback reported errors',
            { cause: record.setupError },
          )
        }
        throw record.setupError
      }
      return () => this.#disposeRecord(record)
    })
  }

  /** Create a child ownership boundary whose lifetime is owned by this one. */
  child(): EffectStack {
    this.#assertActive()
    const child = new EffectStack()
    const record: EffectRecord = {
      disposers: [() => child.dispose()],
      setup: Promise.resolve(),
      setupComplete: true,
      setupFailed: false,
    }
    this.#records.push(record)
    return child
  }

  /**
   * Recover every owned effect. Independent effect groups start in reverse
   * registration order and may finish concurrently.
   */
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal

    this.#state = 'disposing'
    const records = [...this.#records].reverse()
    this.#disposal = Promise.allSettled(
      records.map((record) => this.#disposeRecord(record)),
    ).then((results) => {
      this.#state = 'disposed'
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (errors.length > 0) {
        throw new AggregateError(errors, 'one or more effects failed to dispose')
      }
    })

    return this.#disposal
  }

  async #collect(record: EffectRecord, setup: EffectSetup): Promise<void> {
    const value = await setup()
    if (value === undefined) return

    if (typeof value === 'function') {
      record.disposers.push(value)
      return
    }

    if (isAsyncIterable(value)) {
      for await (const disposer of value) {
        assertDisposer(disposer)
        record.disposers.push(disposer)
      }
      return
    }

    if (isIterable(value)) {
      for (const disposer of value) {
        assertDisposer(disposer)
        record.disposers.push(disposer)
      }
      return
    }

    throw new TypeError('an effect returned an unsupported value')
  }

  #disposeRecord(record: EffectRecord): Promise<void> {
    if (record.disposal) return record.disposal

    record.disposal = (async () => {
      if (!record.setupComplete) {
        await record.setup
      }

      const errors: unknown[] = []
      for (const disposer of record.disposers.splice(0).reverse()) {
        try {
          await disposer()
        } catch (error) {
          errors.push(error)
        }
      }
      this.#remove(record)

      if (errors.length > 0) {
        throw new AggregateError(errors, 'one or more disposers failed')
      }
    })()

    return record.disposal
  }

  #remove(record: EffectRecord): void {
    const index = this.#records.indexOf(record)
    if (index !== -1) this.#records.splice(index, 1)
  }

  #assertActive(): void {
    if (this.#state !== 'active') {
      throw new Error(`cannot acquire an effect while scope is ${this.#state}`)
    }
  }
}
