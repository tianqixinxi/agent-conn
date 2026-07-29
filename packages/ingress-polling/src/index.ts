import type {
  RuntimeIngressAdapter,
  RuntimeIngressDeliveryResult,
  RuntimeIngressEvent,
} from '@agent-comm/runtime-ingress'

interface PollingQueueEntry {
  event: RuntimeIngressEvent
  availableAt: number
  leaseUntil?: number | undefined
  deliveries: number
}

export interface PollingIngressDelivery {
  event: RuntimeIngressEvent
  deliveries: number
  leaseExpiresAt: string
}

export interface PollingIngressOptions {
  maxQueueSize?: number | undefined
  defaultLeaseMs?: number | undefined
  now?: (() => number) | undefined
}

/**
 * Pull-based ingress for harnesses that cannot receive unsolicited events.
 *
 * Poll leases are redelivered after their visibility timeout until `ack` is
 * called. AgentComm's upstream inbox remains the durable source of truth across
 * process restarts.
 */
export class PollingIngressAdapter implements RuntimeIngressAdapter {
  readonly id = 'polling'
  readonly capabilities = {
    delivery: 'poll',
    wake: 'poll',
    background: false,
    interactiveApproval: false,
    streaming: false,
    durability: 'upstream',
  } as const

  readonly #entries = new Map<string, PollingQueueEntry>()
  readonly #maxQueueSize: number
  readonly #defaultLeaseMs: number
  readonly #now: () => number

  constructor(options: PollingIngressOptions = {}) {
    this.#maxQueueSize = Math.max(1, options.maxQueueSize ?? 1_000)
    this.#defaultLeaseMs = Math.max(100, options.defaultLeaseMs ?? 30_000)
    this.#now = options.now ?? Date.now
  }

  async deliver(event: RuntimeIngressEvent): Promise<RuntimeIngressDeliveryResult> {
    if (this.#entries.has(event.eventId)) return { status: 'accepted', duplicate: true }
    if (this.#entries.size >= this.#maxQueueSize) {
      return { status: 'deferred', detail: 'polling ingress queue is full' }
    }
    this.#entries.set(event.eventId, {
      event,
      availableAt: this.#now(),
      deliveries: 0,
    })
    return { status: 'accepted' }
  }

  poll(options: { limit?: number | undefined; leaseMs?: number | undefined } = {}): PollingIngressDelivery[] {
    const now = this.#now()
    const limit = Math.max(1, options.limit ?? 10)
    const leaseMs = Math.max(100, options.leaseMs ?? this.#defaultLeaseMs)
    const result: PollingIngressDelivery[] = []

    for (const entry of this.#entries.values()) {
      if (result.length >= limit) break
      if (entry.availableAt > now) continue
      if (entry.leaseUntil !== undefined && entry.leaseUntil > now) continue
      entry.deliveries += 1
      entry.leaseUntil = now + leaseMs
      result.push({
        event: entry.event,
        deliveries: entry.deliveries,
        leaseExpiresAt: new Date(entry.leaseUntil).toISOString(),
      })
    }
    return result
  }

  ack(eventId: string): boolean {
    return this.#entries.delete(eventId)
  }

  nack(eventId: string, retryAfterMs = 0): boolean {
    const entry = this.#entries.get(eventId)
    if (!entry) return false
    entry.availableAt = this.#now() + Math.max(0, retryAfterMs)
    entry.leaseUntil = undefined
    return true
  }

  size(): number {
    return this.#entries.size
  }
}
