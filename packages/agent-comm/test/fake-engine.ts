import type { AgentCard, AuditEntry, Channel, Message, NodeIdentity, Peer } from '@agent-comm/protocol'
import { AgentCommError, newMessageId, nowIso } from '@agent-comm/protocol'
import type {
  Actor,
  AuditQuery,
  ConnectResult,
  CreateInviteInput,
  Engine,
  HeldMessage,
  ReadInboxInput,
  SendInput,
  SendResult,
  WhoamiResult,
} from '../src/engine/api.js'

/**
 * mcp-*.test.ts / cli-*.test.ts 共用的最小内存 Engine 假实现(实现 engine/api.ts 的 Engine 接口)。
 * 不是测试文件本身(不匹配 *.test.ts),不会被 vitest 当作用例收集。
 *
 * 设计目的:
 * - 让 mcp/server.ts、cli/index.ts 的测试完全不依赖 W1 的真实 engine(尚未实现)。
 * - `calls` 记录每次调用的方法名/参数/actor,方便断言"参数被正确转发""T3 用了 human actor"等。
 * - T3 方法(deliverHeld/dropHeld/editHeld/setChannelMode)按 I4 语义校验 actor 必须是 'human'。
 * - 各方法都是可结构化配置的最小实现;需要特殊行为(比如让某方法抛错)时,测试直接在实例上
 *   重新赋值对应方法即可(class 方法是实例可覆盖的属性)。
 */

export interface FakeEngineState {
  nodeId?: string
  profileName?: string
  channels?: Channel[]
  memberships?: { channel: string; alias: string; home: string }[]
  peers?: Peer[]
  inbox?: Message[]
  held?: HeldMessage[]
  audit?: AuditEntry[]
}

export interface RecordedCall {
  method: string
  args: unknown[]
  actor?: Actor | undefined
}

export class FakeEngine implements Engine {
  readonly calls: RecordedCall[] = []
  closed = false

  private nodeId: string
  private profileName: string
  private channels: Channel[]
  private memberships: { channel: string; alias: string; home: string }[]
  private peers: Peer[]
  private inbox: Message[]
  private held: HeldMessage[]
  private audit: AuditEntry[]

  constructor(state: FakeEngineState = {}) {
    this.nodeId = state.nodeId ?? 'n-fake0000'
    this.profileName = state.profileName ?? 'default'
    this.channels = state.channels ?? []
    this.memberships = state.memberships ?? []
    this.peers = state.peers ?? []
    this.inbox = state.inbox ?? []
    this.held = state.held ?? []
    this.audit = state.audit ?? []
  }

  private record(method: string, args: unknown[], actor?: Actor): void {
    this.calls.push({ method, args, actor })
  }

  private requireHuman(actor: Actor, method: string): void {
    if (actor !== 'human') {
      throw new AgentCommError('SCOPE_DENIED', `${method} 是 T3 治理动作,actor 必须是 'human'`)
    }
  }

  async whoami(): Promise<WhoamiResult> {
    this.record('whoami', [])
    return { nodeId: this.nodeId, profile: this.profileName, memberships: this.memberships }
  }

  async identity(): Promise<NodeIdentity> {
    this.record('identity', [])
    return { nodeId: this.nodeId, publicKey: 'fake-pub-key', privateKeyRef: 'fake-key-ref', relays: [] }
  }

  async createChannel(
    input: {
      name: string
      alias: string
      displayName?: string | undefined
      mode?: Channel['mode'] | undefined
      description?: string | undefined
      home?: string | undefined
    },
    actor: Actor,
  ): Promise<Channel> {
    this.record('createChannel', [input], actor)
    const channel: Channel = {
      name: input.name,
      home: input.home ?? 'local:/fake/local-hub.db',
      mode: input.mode ?? 'auto',
      createdAt: nowIso(),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.description === undefined ? {} : { description: input.description }),
    }
    this.channels.push(channel)
    this.memberships.push({ channel: input.name, alias: input.alias, home: channel.home })
    return channel
  }

  async joinChannel(input: { channel: string; alias: string }, actor: Actor): Promise<Channel> {
    this.record('joinChannel', [input], actor)
    const channel = this.channels.find((c) => c.name === input.channel)
    if (!channel) throw new AgentCommError('CHANNEL_NOT_FOUND', input.channel)
    this.memberships.push({ channel: input.channel, alias: input.alias, home: channel.home })
    return channel
  }

  async leaveChannel(input: { channel: string }, actor: Actor): Promise<void> {
    this.record('leaveChannel', [input], actor)
    this.memberships = this.memberships.filter((m) => m.channel !== input.channel)
  }

  async listChannels(): Promise<Channel[]> {
    this.record('listChannels', [])
    return this.channels
  }

  async listPeers(input?: { channel?: string | undefined }): Promise<Peer[]> {
    this.record('listPeers', [input])
    return input?.channel ? this.peers.filter((p) => p.channel === input.channel) : this.peers
  }

  async publishCard(card: AgentCard, actor: Actor): Promise<void> {
    this.record('publishCard', [card], actor)
  }

  async createInvite(
    input: CreateInviteInput,
    actor: Actor,
  ): Promise<{ link: string; expiresAt?: string | undefined }> {
    this.record('createInvite', [input], actor)
    return { link: `agentcomm-local:?path=/fake/local-hub.db&t=tok-${this.calls.length}` }
  }

  async connect(
    input: { link: string; alias: string; card?: AgentCard | undefined },
    actor: Actor,
  ): Promise<ConnectResult> {
    this.record('connect', [input], actor)
    const channel = 'fake-channel'
    this.memberships.push({ channel, alias: input.alias, home: 'local:/fake/local-hub.db' })
    return { channel, myAlias: input.alias, peers: this.peers }
  }

  async send(input: SendInput, actor: Actor): Promise<SendResult> {
    this.record('send', [input], actor)
    return { messageId: input.messageId ?? newMessageId(), status: 'delivered' }
  }

  async readInbox(input?: ReadInboxInput): Promise<Message[]> {
    this.record('readInbox', [input])
    return this.inbox
  }

  async ack(input: { messageId: string }): Promise<void> {
    this.record('ack', [input])
  }

  async syncOnce(channel?: string): Promise<{ pulled: number; pushed: number }> {
    this.record('syncOnce', [channel])
    return { pulled: 0, pushed: 0 }
  }

  async listHeld(channel?: string): Promise<HeldMessage[]> {
    this.record('listHeld', [channel])
    return channel ? this.held.filter((h) => h.channel === channel) : this.held
  }

  async deliverHeld(input: { messageId: string }, actor: Actor): Promise<void> {
    this.record('deliverHeld', [input], actor)
    this.requireHuman(actor, 'deliverHeld')
    this.held = this.held.filter((h) => h.message.messageId !== input.messageId)
  }

  async dropHeld(input: { messageId: string }, actor: Actor): Promise<void> {
    this.record('dropHeld', [input], actor)
    this.requireHuman(actor, 'dropHeld')
    this.held = this.held.filter((h) => h.message.messageId !== input.messageId)
  }

  async editHeld(
    input: { messageId: string; payload?: unknown; contentType?: string | undefined },
    actor: Actor,
  ): Promise<void> {
    this.record('editHeld', [input], actor)
    this.requireHuman(actor, 'editHeld')
    const entry = this.held.find((h) => h.message.messageId === input.messageId)
    if (entry && input.payload !== undefined) entry.message.payload = input.payload
    if (entry && input.contentType !== undefined) entry.message.contentType = input.contentType
  }

  async setChannelMode(input: { channel: string; mode: Channel['mode'] }, actor: Actor): Promise<void> {
    this.record('setChannelMode', [input], actor)
    this.requireHuman(actor, 'setChannelMode')
    const channel = this.channels.find((c) => c.name === input.channel)
    if (channel) channel.mode = input.mode
  }

  async auditQuery(q?: AuditQuery): Promise<AuditEntry[]> {
    this.record('auditQuery', [q])
    return this.audit
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

/** 造一条 held 消息(测试用):默认 messageId/ts 自动生成,可覆盖任意字段。 */
export function makeHeldMessage(
  overrides: Partial<HeldMessage['message']> & { channel?: string },
): HeldMessage {
  const { channel = 'daily', ...messageOverrides } = overrides
  return {
    channel,
    message: {
      messageId: newMessageId(),
      from: 'alice',
      to: 'bob',
      channel,
      traceId: 'trace-1',
      hop: 0,
      payload: { text: 'hello' },
      injectedByHuman: false,
      ts: nowIso(),
      status: 'held',
      ...messageOverrides,
    },
  }
}
