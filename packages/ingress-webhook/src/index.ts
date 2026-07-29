import { createHmac } from 'node:crypto'
import type {
  RuntimeIngressAdapter,
  RuntimeIngressDeliveryResult,
  RuntimeIngressEvent,
} from '@agent-comm/runtime-ingress'

export interface WebhookIngressOptions {
  url: string
  headers?: Readonly<Record<string, string>> | undefined
  secret?: string | undefined
  timeoutMs?: number | undefined
  fetch?: typeof globalThis.fetch | undefined
  now?: (() => number) | undefined
}

/**
 * Pushes normalized ingress events to a harness-owned HTTP endpoint.
 *
 * When a secret is configured, receivers can verify
 * `HMAC-SHA256(secret, timestamp + "." + rawBody)` using the timestamp and
 * signature headers. Receivers must deduplicate on `eventId`.
 */
export class WebhookIngressAdapter implements RuntimeIngressAdapter {
  readonly id = 'webhook'
  readonly capabilities = {
    delivery: 'webhook',
    wake: 'remote',
    background: true,
    interactiveApproval: false,
    streaming: false,
    durability: 'upstream',
  } as const

  readonly #url: string
  readonly #headers: Readonly<Record<string, string>>
  readonly #secret: string | undefined
  readonly #timeoutMs: number
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number

  constructor(options: WebhookIngressOptions) {
    const url = new URL(options.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('webhook ingress URL must use http: or https:')
    }
    this.#url = url.toString()
    this.#headers = options.headers ?? {}
    this.#secret = options.secret
    this.#timeoutMs = Math.max(100, options.timeoutMs ?? 10_000)
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
  }

  async deliver(event: RuntimeIngressEvent): Promise<RuntimeIngressDeliveryResult> {
    const body = JSON.stringify(event)
    const timestamp = String(this.#now())
    const signature = this.#secret
      ? createHmac('sha256', this.#secret).update(`${timestamp}.${body}`).digest('base64url')
      : undefined

    let response: Response
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          ...this.#headers,
          'content-type': 'application/json',
          'x-agentcomm-event-id': event.eventId,
          'x-agentcomm-event-type': event.eventType,
          'x-agentcomm-timestamp': timestamp,
          ...(signature ? { 'x-agentcomm-signature': `v1=${signature}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      return {
        status: 'deferred',
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    if (response.ok) return { status: 'accepted' }
    if (response.status === 409) return { status: 'accepted', duplicate: true }
    if (response.status === 404 || response.status === 405 || response.status === 415) {
      return { status: 'unsupported', detail: `webhook returned HTTP ${response.status}` }
    }
    if (
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      const retryAfter = response.headers.get('retry-after')
      const retrySeconds = retryAfter ? Number(retryAfter) : Number.NaN
      return {
        status: 'deferred',
        ...(Number.isFinite(retrySeconds) ? { retryAfterMs: retrySeconds * 1_000 } : {}),
        detail: `webhook returned HTTP ${response.status}`,
      }
    }
    return { status: 'rejected', detail: `webhook returned HTTP ${response.status}` }
  }
}
