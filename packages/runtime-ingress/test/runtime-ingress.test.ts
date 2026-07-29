import {
  createCallbackIngressAdapter,
  type RuntimeIngressAdapter,
  RuntimeIngressDispatcher,
  type RuntimeIngressEvent,
} from '@agent-comm/runtime-ingress'
import { describe, expect, it, vi } from 'vitest'

const event: RuntimeIngressEvent = {
  eventId: 'm-1',
  eventType: 'message',
  source: 'agent-comm',
  content: 'hello',
  metadata: { channel: 'test' },
  occurredAt: '2026-07-28T00:00:00.000Z',
}

function adapter(
  id: string,
  status: 'accepted' | 'deferred' | 'unsupported' | 'rejected',
): RuntimeIngressAdapter {
  return {
    id,
    capabilities: {
      delivery: 'native-push',
      wake: 'native',
      background: true,
      interactiveApproval: false,
      streaming: false,
      durability: 'upstream',
    },
    async deliver() {
      return status === 'rejected' ? { status, detail: 'no' } : { status }
    },
  }
}

describe('RuntimeIngressDispatcher', () => {
  it('skips unsupported adapters and records the selected adapter', async () => {
    const dispatcher = new RuntimeIngressDispatcher([
      adapter('unsupported', 'unsupported'),
      adapter('native', 'accepted'),
    ])

    await expect(dispatcher.deliver(event)).resolves.toMatchObject({
      status: 'accepted',
      adapterId: 'native',
      attempts: [
        { adapterId: 'unsupported', status: 'unsupported' },
        { adapterId: 'native', status: 'accepted' },
      ],
    })
  })

  it('does not fail over an ambiguous deferred delivery by default', async () => {
    const fallback = vi.fn()
    const dispatcher = new RuntimeIngressDispatcher([
      adapter('remote', 'deferred'),
      createCallbackIngressAdapter('fallback', fallback),
    ])

    await expect(dispatcher.deliver(event)).resolves.toMatchObject({
      status: 'deferred',
      adapterId: 'remote',
    })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('starts in order and stops in reverse order', async () => {
    const calls: string[] = []
    const first = adapter('first', 'accepted')
    first.start = () => void calls.push('start-first')
    first.stop = () => void calls.push('stop-first')
    const second = adapter('second', 'accepted')
    second.start = () => void calls.push('start-second')
    second.stop = () => void calls.push('stop-second')
    const dispatcher = new RuntimeIngressDispatcher([first, second])

    await dispatcher.start({ runtimeInstanceId: 'r-runtime-0001' })
    await dispatcher.stop()

    expect(calls).toEqual(['start-first', 'start-second', 'stop-second', 'stop-first'])
  })
})
