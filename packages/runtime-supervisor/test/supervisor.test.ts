import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeIngressAdapter } from '@agent-comm/runtime-ingress'
import { describe, expect, it } from 'vitest'
import {
  FileRuntimeRegistry,
  NativeFirstIngressRouter,
  RuntimeAdapterRegistry,
  RuntimeSupervisor,
} from '../src/index.js'

function adapter(id: string, status: 'accepted' | 'unsupported'): RuntimeIngressAdapter {
  return {
    id,
    capabilities: {
      delivery: 'process',
      wake: 'process',
      background: true,
      interactiveApproval: false,
      streaming: false,
      durability: 'upstream',
    },
    async deliver() {
      return { status }
    },
  }
}

describe('runtime supervisor', () => {
  it('persists registration and selects the highest-priority detected adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentcomm-runtime-'))
    const registry = new FileRuntimeRegistry(join(root, 'runtimes.json'))
    const registration = registry.register({
      id: 'worker',
      profile: 'worker',
      harness: 'auto',
      channels: ['c-one'],
      args: [],
      applications: [],
      trustedAutoResume: true,
    })
    const adapters = new RuntimeAdapterRegistry()
    adapters.register({
      id: 'low',
      harnesses: ['process'],
      priority: 1,
      detect: () => true,
      create: () => adapter('low', 'accepted'),
    })
    adapters.register({
      id: 'high',
      harnesses: ['codex-exec'],
      priority: 10,
      detect: () => true,
      create: () => adapter('high', 'accepted'),
    })
    const supervisor = new RuntimeSupervisor({
      registry,
      adapters,
      launcher: {
        async launch({ runtimeInstanceId }) {
          return { runtimeInstanceId, async close() {} }
        },
      },
    })
    await expect(supervisor.start(registration)).resolves.toMatchObject({
      state: 'online',
      adapterId: 'high',
    })
    await supervisor.stopAll()
    expect(registry.statuses()[0]?.state).toBe('offline')
  })

  it('prefers native and falls through only when unsupported', async () => {
    const router = new NativeFirstIngressRouter([
      { proximity: 'remote', adapter: adapter('remote', 'accepted') },
      { proximity: 'native', adapter: adapter('native', 'unsupported') },
      { proximity: 'local', adapter: adapter('local', 'accepted') },
    ])
    await expect(
      router.deliver({
        eventId: 'm-one',
        eventType: 'message',
        source: 'test',
        content: 'hello',
        metadata: {},
        occurredAt: new Date().toISOString(),
      }),
    ).resolves.toMatchObject({ status: 'accepted' })
  })

  it('continues starting trusted runtimes after one registration fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentcomm-runtime-isolation-'))
    const registry = new FileRuntimeRegistry(join(root, 'runtimes.json'))
    registry.register({
      id: 'broken',
      profile: 'broken',
      harness: 'process',
      channels: ['c-one'],
      args: [],
      applications: [],
      trustedAutoResume: true,
    })
    registry.register({
      id: 'healthy',
      profile: 'healthy',
      harness: 'process',
      channels: ['c-one'],
      args: [],
      applications: [],
      trustedAutoResume: true,
    })
    const adapters = new RuntimeAdapterRegistry()
    adapters.register({
      id: 'process',
      harnesses: ['process'],
      priority: 1,
      detect: () => true,
      create: () => adapter('process', 'accepted'),
    })
    const supervisor = new RuntimeSupervisor({
      registry,
      adapters,
      launcher: {
        async launch({ registration, runtimeInstanceId }) {
          if (registration.id === 'broken') throw new Error('broken runtime')
          return { runtimeInstanceId, async close() {} }
        },
      },
    })

    await expect(supervisor.startAll()).resolves.toEqual([
      expect.objectContaining({ id: 'broken', state: 'failed', detail: 'broken runtime' }),
      expect.objectContaining({ id: 'healthy', state: 'online' }),
    ])
    await supervisor.stopAll()
  })
})
