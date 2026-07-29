import {
  type ApplicationEventSelector,
  ApplicationEventSelectorSchema,
  negotiateApplicationExtension,
  type SupportedApplicationExtension,
  SupportedApplicationExtensionSchema,
} from '@agent-comm/application-spec'

export interface ApplicationPublishRequest {
  channelId: string
  to: string
  selector: ApplicationEventSelector
  body: unknown
  contextId?: string | undefined
  mediaType?: string | undefined
}

export interface ApplicationRespondRequest {
  eventId: string
  eventType: string
  body: unknown
  terminal?: boolean | undefined
  mediaType?: string | undefined
}

export interface ApplicationPublication {
  messageId: string
  taskId: string
  contextId: string
}

/**
 * Implemented by a harness binding (Claude Channel, HTTP gateway, tests, etc.).
 * Community clients depend on this narrow API instead of relay or MCP details.
 */
export interface ApplicationTransport {
  publish(request: ApplicationPublishRequest): Promise<ApplicationPublication>
  respond(request: ApplicationRespondRequest): Promise<ApplicationPublication>
}

export class ApplicationClient {
  constructor(readonly transport: ApplicationTransport) {}

  publish(request: ApplicationPublishRequest): Promise<ApplicationPublication> {
    return this.transport.publish({
      ...request,
      selector: ApplicationEventSelectorSchema.parse(request.selector),
    })
  }

  respond(request: ApplicationRespondRequest): Promise<ApplicationPublication> {
    if (!request.eventId) throw new Error('eventId is required')
    if (!request.eventType.trim()) throw new Error('eventType is required')
    return this.transport.respond({ ...request, eventType: request.eventType.trim() })
  }
}

export interface VerifiedApplicationEvent {
  messageId: string
  channelId: string
  from: string
  selector: ApplicationEventSelector
  body: unknown
  contextId?: string | undefined
  taskId?: string | undefined
  receivedAt?: string | undefined
  sourceRuntimeInstanceId?: string | undefined
}

/**
 * Consumers return data-only effects. The host decides whether an effect is
 * allowed and how to perform it; a community extension never receives raw tools.
 */
export type ApplicationEffect =
  | {
      type: 'publish'
      to: string
      selector: ApplicationEventSelector
      body: unknown
      contextId?: string | undefined
    }
  | {
      type: 'request-input'
      prompt: string
      schema?: unknown
    }
  | {
      type: 'request-authorization'
      prompt: string
      scope: unknown
    }
  | {
      type: 'complete'
      result?: unknown
    }
  | {
      type: 'store-artifact'
      name: string
      mediaType: string
      content: unknown
    }

export interface ApplicationConsumerContext {
  runtimeId: string
  profilePrincipal: string
  channelId: string
  extensionUri: string
  contextId: string
  state: unknown
  taskState: import('./runtime.js').ApplicationTaskState
  stale: boolean
}

export interface ApplicationConsumerResult {
  status: 'handled' | 'ignored'
  effects: readonly ApplicationEffect[]
  state?: unknown
  taskState?: import('./runtime.js').ApplicationTaskState | undefined
}

export interface ApplicationHarnessOutcome {
  status: 'completed' | 'failed'
  result?: unknown
  error?: string | undefined
}

export interface ApplicationConsumer {
  id: string
  version?: string | undefined
  supports: readonly SupportedApplicationExtension[]
  handle(
    event: VerifiedApplicationEvent,
    context: ApplicationConsumerContext,
  ): Promise<ApplicationConsumerResult> | ApplicationConsumerResult
  /**
   * Optional continuation owned by the application protocol. It translates a
   * harness result into protocol-native effects (for example
   * `task.completed` or `response.created`) without teaching transport code
   * any workflow semantics.
   */
  resume?(
    source: VerifiedApplicationEvent,
    outcome: ApplicationHarnessOutcome,
    context: ApplicationConsumerContext,
  ): Promise<ApplicationConsumerResult> | ApplicationConsumerResult
}

export type ApplicationDispatchResult =
  | {
      status: 'handled' | 'ignored'
      consumerId: string
      effects: readonly ApplicationEffect[]
    }
  | {
      status: 'unsupported'
      selector: ApplicationEventSelector
      effects: readonly []
    }

interface RegisteredConsumer {
  consumer: ApplicationConsumer
  supports: SupportedApplicationExtension[]
  channels?: ReadonlySet<string> | undefined
}

export interface ResolvedApplicationConsumer {
  consumer: ApplicationConsumer
  negotiated: SupportedApplicationExtension
}

export class ApplicationConsumerRegistry {
  readonly #consumers = new Map<string, RegisteredConsumer>()

  register(consumer: ApplicationConsumer, options: { channels?: readonly string[] } = {}): void {
    const channels = options.channels ? [...new Set(options.channels)].sort() : undefined
    const registrationKey = `${consumer.id}\u0000${channels?.join(',') ?? '*'}`
    if (this.#consumers.has(registrationKey)) {
      throw new Error(
        `application consumer already registered: ${consumer.id} for ${channels?.join(',') ?? '*'}`,
      )
    }
    const supports = consumer.supports.map((item) => SupportedApplicationExtensionSchema.parse(item))
    this.#consumers.set(registrationKey, {
      consumer,
      supports,
      ...(channels ? { channels: new Set(channels) } : {}),
    })
  }

  unregister(consumerId: string): boolean {
    let changed = false
    for (const [key, registration] of this.#consumers) {
      if (registration.consumer.id !== consumerId) continue
      this.#consumers.delete(key)
      changed = true
    }
    return changed
  }

  supportedExtensions(): SupportedApplicationExtension[] {
    return [...this.#consumers.values()].flatMap(({ supports }) => supports.map((item) => ({ ...item })))
  }

  resolve(selector: ApplicationEventSelector, channelId?: string): ResolvedApplicationConsumer | undefined {
    const registrations = [...this.#consumers.values()].sort((left, right) => {
      const score = (channels?: ReadonlySet<string>): number =>
        channels?.has(channelId ?? '') ? 2 : channels?.has('*') ? 1 : 0
      return score(right.channels) - score(left.channels)
    })
    for (const { consumer, supports, channels } of registrations) {
      if (channels && (!channelId || (!channels.has(channelId) && !channels.has('*')))) continue
      const negotiated = negotiateApplicationExtension(supports, [
        { uri: selector.uri, version: selector.version },
      ])
      if (negotiated?.version === selector.version) return { consumer, negotiated }
    }
    return undefined
  }

  async dispatch(
    event: VerifiedApplicationEvent,
    context: ApplicationConsumerContext,
  ): Promise<ApplicationDispatchResult> {
    const resolved = this.resolve(event.selector, event.channelId)
    if (resolved) {
      const result = await resolved.consumer.handle(event, context)
      return {
        status: result.status,
        consumerId: resolved.consumer.id,
        effects: result.effects,
      }
    }

    // Fail closed: an unknown URI/version is data to surface or quarantine. It
    // never causes dynamic import, package installation, or generic execution.
    return { status: 'unsupported', selector: event.selector, effects: [] }
  }
}

export * from './conformance.js'
export * from './legacy.js'
export * from './runtime.js'
