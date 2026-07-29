import {
  ApplicationConsumerRegistry,
  ApplicationRuntime,
  InMemoryApplicationRuntimeStore,
} from '@agent-comm/client-sdk'
import { nowIso } from '@agent-comm/core'
import { createCallbackIngressAdapter } from '@agent-comm/runtime-ingress'
import { describe, expect, it, vi } from 'vitest'
import type { ProfilePaths } from '../src/config.js'
import { createIngressRuntime } from '../src/runtime/ingress-runtime.js'
import { FakeEngine } from './fake-engine.js'

const profile: ProfilePaths = {
  name: 'test',
  rootDir: '/tmp/agentcomm-test',
  dir: '/tmp/agentcomm-test/profiles/test',
  storePath: '/tmp/agentcomm-test/profiles/test/store.db',
  identityKeyPath: '/tmp/agentcomm-test/profiles/test/identity.key',
  defaultHubPath: '/tmp/agentcomm-test/local-hub.db',
}

describe('createIngressRuntime', () => {
  it('activates durable memberships without connecting a Claude or MCP host', async () => {
    const engine = new FakeEngine({
      memberships: [{ channel: 'c-runtime', alias: 'alice', home: 'https://relay.example' }],
      channels: [
        {
          name: 'runtime',
          channelId: 'c-runtime',
          home: 'https://relay.example',
          mode: 'auto',
          visibility: 'private',
          createdAt: nowIso(),
        },
      ],
    })
    const callback = vi.fn()
    const applicationRuntime = new ApplicationRuntime({
      runtimeInstanceId: 'r-ingress-runtime-001',
      profilePrincipal: 'n-fake0000',
      registry: new ApplicationConsumerRegistry(),
      store: new InMemoryApplicationRuntimeStore(),
    })
    const runtime = await createIngressRuntime(profile, {
      engine,
      channels: ['c-runtime'],
      ingress: createCallbackIngressAdapter('test', callback),
      applicationRuntime,
      pollIntervalMs: 60_000,
      stderr: () => {},
    })

    expect(runtime.bridge.activeChannels()).toEqual(['c-runtime'])
    expect(engine.calls.some((call) => call.method === 'publishCard')).toBe(true)
    await runtime.close()
    expect(engine.closed).toBe(true)
  })
})
