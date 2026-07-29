/**
 * A harness-neutral event accepted by a runtime ingress adapter.
 *
 * AgentComm's logical channels, transport envelopes, application extensions,
 * and MCP tools deliberately stay outside this contract. An ingress adapter is
 * only responsible for making an already-normalized event available to a
 * concrete agent runtime.
 */
export interface RuntimeIngressEvent {
  eventId: string
  eventType: string
  source: string
  content: string
  metadata: Readonly<Record<string, string>>
  occurredAt: string
}

export type RuntimeIngressDeliveryMode = 'native-push' | 'poll' | 'webhook' | 'process'
export type RuntimeIngressWakeMode = 'native' | 'poll' | 'remote' | 'process'

export interface RuntimeIngressCapabilities {
  delivery: RuntimeIngressDeliveryMode
  wake: RuntimeIngressWakeMode
  background: boolean
  interactiveApproval: boolean
  streaming: boolean
  /**
   * `upstream` means the adapter relies on AgentComm's durable inbox for
   * redelivery. `adapter` means it also maintains its own durable queue.
   */
  durability: 'upstream' | 'adapter'
}

export interface RuntimeIngressContext {
  runtimeInstanceId: string
  profilePrincipal?: string | undefined
}

export type RuntimeIngressDeliveryResult =
  | {
      status: 'accepted'
      duplicate?: boolean | undefined
      detail?: string | undefined
    }
  | {
      status: 'deferred'
      retryAfterMs?: number | undefined
      detail?: string | undefined
    }
  | {
      status: 'unsupported'
      detail?: string | undefined
    }
  | {
      status: 'rejected'
      detail: string
    }

export interface RuntimeIngressAdapter {
  readonly id: string
  readonly capabilities: RuntimeIngressCapabilities
  start?(context: RuntimeIngressContext): Promise<void> | void
  deliver(event: RuntimeIngressEvent): Promise<RuntimeIngressDeliveryResult>
  stop?(): Promise<void> | void
}

export interface RuntimeIngressOutcome {
  eventId: string
  status: 'completed' | 'failed'
  result?: unknown
  error?: string | undefined
}

export type RuntimeIngressOutcomeHandler = (outcome: RuntimeIngressOutcome) => Promise<void> | void

export interface RuntimeIngressOutcomeSource {
  setOutcomeHandler(handler: RuntimeIngressOutcomeHandler): void
}

export function isRuntimeIngressOutcomeSource(
  adapter: RuntimeIngressAdapter,
): adapter is RuntimeIngressAdapter & RuntimeIngressOutcomeSource {
  return (
    'setOutcomeHandler' in adapter &&
    typeof (adapter as Partial<RuntimeIngressOutcomeSource>).setOutcomeHandler === 'function'
  )
}

export type RuntimeIngressDispatchResult = RuntimeIngressDeliveryResult & {
  adapterId?: string | undefined
  attempts: readonly {
    adapterId: string
    status: RuntimeIngressDeliveryResult['status']
    detail?: string | undefined
  }[]
}

export interface RuntimeIngressDispatcherOptions {
  /**
   * A deferred result can be ambiguous: the adapter may have accepted the event
   * before its response was lost. Failover is therefore opt-in and every
   * adapter must deduplicate by eventId when it is enabled.
   */
  fallbackOnDeferred?: boolean | undefined
}

/**
 * Ordered ingress selection. Unsupported adapters are skipped. Rejections are
 * final. Deferred delivery only falls through when explicitly enabled.
 */
export class RuntimeIngressDispatcher implements RuntimeIngressAdapter {
  readonly id = 'runtime-ingress-dispatcher'
  readonly capabilities: RuntimeIngressCapabilities
  readonly #adapters: readonly RuntimeIngressAdapter[]
  readonly #fallbackOnDeferred: boolean

  constructor(adapters: readonly RuntimeIngressAdapter[], options: RuntimeIngressDispatcherOptions = {}) {
    if (adapters.length === 0) throw new Error('at least one runtime ingress adapter is required')
    this.#adapters = [...adapters]
    this.#fallbackOnDeferred = options.fallbackOnDeferred ?? false
    this.capabilities = {
      delivery: adapters[0]?.capabilities.delivery ?? 'poll',
      wake: adapters.some((adapter) => adapter.capabilities.wake === 'native')
        ? 'native'
        : (adapters[0]?.capabilities.wake ?? 'poll'),
      background: adapters.some((adapter) => adapter.capabilities.background),
      interactiveApproval: adapters.some((adapter) => adapter.capabilities.interactiveApproval),
      streaming: adapters.some((adapter) => adapter.capabilities.streaming),
      durability: adapters.some((adapter) => adapter.capabilities.durability === 'adapter')
        ? 'adapter'
        : 'upstream',
    }
  }

  async start(context: RuntimeIngressContext): Promise<void> {
    for (const adapter of this.#adapters) await adapter.start?.(context)
  }

  async deliver(event: RuntimeIngressEvent): Promise<RuntimeIngressDispatchResult> {
    const attempts: {
      adapterId: string
      status: RuntimeIngressDeliveryResult['status']
      detail?: string | undefined
    }[] = []
    let last: RuntimeIngressDeliveryResult = {
      status: 'unsupported',
      detail: 'no ingress adapter accepted the event',
    }

    for (const adapter of this.#adapters) {
      let result: RuntimeIngressDeliveryResult
      try {
        result = await adapter.deliver(event)
      } catch (error) {
        result = {
          status: 'deferred',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
      attempts.push({
        adapterId: adapter.id,
        status: result.status,
        ...('detail' in result && result.detail ? { detail: result.detail } : {}),
      })
      last = result
      if (result.status === 'accepted' || result.status === 'rejected') {
        return { ...result, adapterId: adapter.id, attempts }
      }
      if (result.status === 'deferred' && !this.#fallbackOnDeferred) {
        return { ...result, adapterId: adapter.id, attempts }
      }
    }

    return { ...last, attempts }
  }

  async stop(): Promise<void> {
    for (const adapter of [...this.#adapters].reverse()) await adapter.stop?.()
  }
}

export type RuntimeIngressCallback = (
  event: RuntimeIngressEvent,
) => Promise<RuntimeIngressDeliveryResult | undefined> | RuntimeIngressDeliveryResult | undefined

/** Small adapter used by tests and existing callback-based integrations. */
export function createCallbackIngressAdapter(
  id: string,
  callback: RuntimeIngressCallback,
  capabilities: Partial<RuntimeIngressCapabilities> = {},
): RuntimeIngressAdapter {
  return {
    id,
    capabilities: {
      delivery: capabilities.delivery ?? 'native-push',
      wake: capabilities.wake ?? 'native',
      background: capabilities.background ?? true,
      interactiveApproval: capabilities.interactiveApproval ?? false,
      streaming: capabilities.streaming ?? false,
      durability: capabilities.durability ?? 'upstream',
    },
    async deliver(event) {
      return (await callback(event)) ?? { status: 'accepted' }
    },
  }
}
