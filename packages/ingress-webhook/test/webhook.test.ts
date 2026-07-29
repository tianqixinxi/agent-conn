import { createHmac } from 'node:crypto'
import { WebhookIngressAdapter } from '@agent-comm/ingress-webhook'
import type { RuntimeIngressEvent } from '@agent-comm/runtime-ingress'
import { describe, expect, it, vi } from 'vitest'

const event: RuntimeIngressEvent = {
  eventId: 'm-webhook',
  eventType: 'message',
  source: 'agent-comm',
  content: 'hello',
  metadata: { channel: 'c-1' },
  occurredAt: '2026-07-28T00:00:00.000Z',
}

describe('WebhookIngressAdapter', () => {
  it('signs the exact JSON body and treats 2xx as accepted', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body)
      const headers = new Headers(init?.headers)
      expect(headers.get('x-agentcomm-event-id')).toBe(event.eventId)
      expect(headers.get('x-agentcomm-signature')).toBe(
        `v1=${createHmac('sha256', 'secret').update(`1000.${body}`).digest('base64url')}`,
      )
      return new Response(null, { status: 202 })
    })
    const ingress = new WebhookIngressAdapter({
      url: 'https://runtime.example.test/events',
      secret: 'secret',
      fetch,
      now: () => 1_000,
    })

    await expect(ingress.deliver(event)).resolves.toEqual({ status: 'accepted' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('maps duplicate, retryable, unsupported, and rejected responses', async () => {
    const statuses = [409, 429, 415, 403]
    const fetch = vi.fn(async () => new Response(null, { status: statuses.shift() }))
    const ingress = new WebhookIngressAdapter({
      url: 'https://runtime.example.test/events',
      fetch,
    })

    await expect(ingress.deliver(event)).resolves.toMatchObject({ status: 'accepted', duplicate: true })
    await expect(ingress.deliver(event)).resolves.toMatchObject({ status: 'deferred' })
    await expect(ingress.deliver(event)).resolves.toMatchObject({ status: 'unsupported' })
    await expect(ingress.deliver(event)).resolves.toMatchObject({ status: 'rejected' })
  })
})
