import type {
  AgentCard,
  ChannelMode,
  InviteScope,
  Message,
  MessageEnvelope,
  NodeIdentity,
} from '@agent-comm/protocol'

export type TransportKind = 'local' | 'relay' | 'nats' | 'slim'

/**
 * Store-and-forward binding used by the AgentComm engine. Application semantics are A2A v1; this
 * interface is deliberately limited to delivery, membership and invitation concerns.
 */
export interface TransportBinding {
  readonly kind: TransportKind
  readonly home: string

  createChannel(input: {
    name: string
    displayName?: string | undefined
    mode?: ChannelMode | undefined
    description?: string | undefined
    member: { alias: string; nodeId: string; publicKey?: string | undefined; card?: AgentCard | undefined }
  }): Promise<void>

  join(input: {
    channel?: string | undefined
    joinToken: string
    member: { alias: string; nodeId: string; publicKey?: string | undefined; card?: AgentCard | undefined }
  }): Promise<{
    channel: string
    mode: ChannelMode
    members: { alias: string; nodeId: string; card?: AgentCard | undefined }[]
    scope?: InviteScope | undefined
  }>

  leave(input: { channel: string; alias: string; nodeId: string }): Promise<void>

  mintInvite(input: {
    channel: string
    byNode: string
    scope?: InviteScope | undefined
    ttlMs?: number | undefined
    maxUses?: number | undefined
  }): Promise<{ joinToken: string; expiresAt?: string | undefined }>

  members(channel: string): Promise<{ alias: string; nodeId: string; card?: AgentCard | undefined }[]>
  updateCard(input: { channel: string; alias: string; nodeId: string; card: AgentCard }): Promise<void>

  append(
    channel: string,
    envelopes: MessageEnvelope[],
  ): Promise<
    {
      messageId: string
      seq: number
      status: 'pending' | 'held' | 'delivered'
      duplicate?: boolean | undefined
    }[]
  >

  pullAfter(
    channel: string,
    after: number,
    opts?: { limit?: number | undefined },
  ): Promise<{ messages: Message[]; head: number }>

  ackCursor(channel: string, nodeId: string, seq: number): Promise<void>

  listHeld(channel: string): Promise<Message[]>
  resolveHeld(input: {
    channel: string
    messageId: string
    resolution: 'deliver' | 'drop'
    editedPayload?: unknown
    editedContentType?: string | undefined
    actor: string
  }): Promise<void>
  setMode(channel: string, mode: ChannelMode): Promise<void>

  close(): Promise<void>
}

export interface TransportBindingFactoryInput {
  home: string
  identity: NodeIdentity
  signRequest: (canonical: string) => Promise<string>
}

/** Return undefined when the factory does not support the requested home URL. */
export type TransportBindingFactory = (
  input: TransportBindingFactoryInput,
) => TransportBinding | undefined | Promise<TransportBinding | undefined>

/** Compatibility shape for the existing HTTPS relay implementation. */
export type RelayDriverFactory = (input: {
  relayUrl: string
  identity: NodeIdentity
  signRequest: (canonical: string) => Promise<string>
}) => TransportBinding

/** @deprecated Use TransportBinding. */
export type HomeDriver = TransportBinding
