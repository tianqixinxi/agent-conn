import { PollingIngressAdapter } from '@agent-comm/ingress-polling'
import type { RuntimeIngressEvent } from '@agent-comm/runtime-ingress'
import { describe, expect, it } from 'vitest'

const event: RuntimeIngressEvent = {
  eventId: 'm-poll',
  eventType: 'task',
  source: 'agent-comm',
  content: 'work',
  metadata: {},
  occurredAt: '2026-07-28T00:00:00.000Z',
}

describe('PollingIngressAdapter', () => {
  it('leases, redelivers, and acknowledges events', async () => {
    let now = 1_000
    const ingress = new PollingIngressAdapter({ now: () => now, defaultLeaseMs: 500 })

    await expect(ingress.deliver(event)).resolves.toEqual({ status: 'accepted' })
    await expect(ingress.deliver(event)).resolves.toEqual({ status: 'accepted', duplicate: true })
    expect(ingress.poll()).toMatchObject([{ event, deliveries: 1 }])
    expect(ingress.poll()).toEqual([])

    now += 501
    expect(ingress.poll()).toMatchObject([{ event, deliveries: 2 }])
    expect(ingress.ack(event.eventId)).toBe(true)
    expect(ingress.size()).toBe(0)
  })

  it('nacks with an explicit retry delay and applies backpressure', async () => {
    let now = 2_000
    const ingress = new PollingIngressAdapter({ now: () => now, maxQueueSize: 1 })
    await ingress.deliver(event)
    expect(ingress.poll()).toHaveLength(1)
    expect(ingress.nack(event.eventId, 1_000)).toBe(true)
    expect(ingress.poll()).toEqual([])
    now += 1_000
    expect(ingress.poll()).toHaveLength(1)

    await expect(ingress.deliver({ ...event, eventId: 'm-other' })).resolves.toMatchObject({
      status: 'deferred',
    })
  })
})
