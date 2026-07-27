export * from './api.js'

import type { TransportBinding, TransportBindingFactory, TransportBindingFactoryInput } from './api.js'

/**
 * Explicit transport discovery. Application packages never receive this registry;
 * only the communication runtime resolves a configured home into a binding.
 */
export class TransportBindingRegistry {
  readonly #factories: TransportBindingFactory[] = []

  register(factory: TransportBindingFactory): () => void {
    this.#factories.push(factory)
    return () => {
      const index = this.#factories.indexOf(factory)
      if (index >= 0) this.#factories.splice(index, 1)
    }
  }

  async resolve(input: TransportBindingFactoryInput): Promise<TransportBinding | undefined> {
    for (const factory of this.#factories) {
      const binding = await factory(input)
      if (binding) return binding
    }
    return undefined
  }
}
