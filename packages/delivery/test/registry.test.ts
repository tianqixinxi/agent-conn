import { TransportBindingRegistry } from '@agent-comm/delivery'
import { describe, expect, it } from 'vitest'

describe('transport binding registry', () => {
  it('resolves configured homes without exposing bindings to applications', async () => {
    const registry = new TransportBindingRegistry()
    registry.register(({ home }) =>
      home.startsWith('nats://')
        ? ({
            kind: 'nats',
            home,
          } as never)
        : undefined,
    )
    registry.register(({ home }) =>
      home.startsWith('https://')
        ? ({
            kind: 'relay',
            home,
          } as never)
        : undefined,
    )

    await expect(
      registry.resolve({
        home: 'https://connect.example',
        identity: { nodeId: 'n-test', publicKey: 'pk', privateKeyRef: 'key', relays: [] },
        signRequest: async () => 'signature',
      }),
    ).resolves.toMatchObject({ kind: 'relay', home: 'https://connect.example' })
  })
})
