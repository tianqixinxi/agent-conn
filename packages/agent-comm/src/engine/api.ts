import type {
  AgentCard,
  AuditEntry,
  Channel,
  ChannelMode,
  ChannelVisibility,
  InviteScope,
  Message,
  NodeIdentity,
  Peer,
} from '@agent-comm/protocol'
import type { RelayDriverFactory, TransportBindingFactory } from '../transport/api.js'

export type {
  HomeDriver,
  RelayDriverFactory,
  TransportBinding,
  TransportBindingFactory,
  TransportBindingFactoryInput,
  TransportKind,
} from '../transport/api.js'

/**
 * ⚠️ 契约文件:engine 的公开面。mcp/cli/sync 只 import 本文件与 createEngine。
 * 修改须经 architect(见 DESIGN §6 规则)。
 *
 * 语义要点:
 * - actor 贯穿所有会审计的操作('human' 或 'agent:<alias>')。T3 **变更类**方法
 *   (deliverHeld/dropHeld/editHeld/setChannelMode)在运行时校验并拒绝 agent actor(I4,
 *   防薄适配层误用);listHeld/auditQuery 是只读查询,不带 actor——它们的门在"不出现在
 *   MCP 工具面"(tools.ts 没有对应工具),serve 内部调 listHeld 只为发起 elicitation。
 * - 所有方法幂等或可安全重试(I3)。
 * - payload 一律 unknown,engine 不读内容(I1)。
 */

export type Actor = 'human' | `agent:${string}`

export interface SendInput {
  /** Optional caller-generated id enables A2A idempotency across binding retries. */
  messageId?: string | undefined
  channel?: string | undefined
  to: string // Alias | '*'
  payload: unknown
  contentType?: string | undefined
  replyTo?: string | undefined
  replyBy?: string | undefined
  traceId?: string | undefined
}

export interface SendResult {
  messageId: string
  /** local 家同步落家;relay 家先入 outbox = 'pending' */
  status: 'pending' | 'held' | 'delivered'
}

export interface ReadInboxInput {
  consume?: boolean | undefined
  filter?:
    | {
        channel?: string | undefined
        traceId?: string | undefined
        contentType?: string | undefined
        /** 默认只返回未消费 */
        includeConsumed?: boolean | undefined
      }
    | undefined
  limit?: number | undefined
}

export interface WhoamiResult {
  nodeId: string
  profile: string
  memberships: { channel: string; alias: string; home: string }[]
}

export interface HeldMessage {
  message: Message
  channel: string
}

export interface CreateInviteInput {
  channel: string
  scope?: InviteScope | undefined
  ttlMs?: number | undefined
  maxUses?: number | undefined
}

export interface ConnectResult {
  channel: string
  myAlias: string
  peers: Peer[]
}

export interface AuditQuery {
  channel?: string | undefined
  messageId?: string | undefined
  sinceTs?: string | undefined
  limit?: number | undefined
}

/** L0 业务核心。实现:engine/engine.ts(W1)。 */
export interface Engine {
  // —— 身份/诊断(T1)——
  whoami(): Promise<WhoamiResult>
  identity(): Promise<NodeIdentity>

  // —— 频道(建立/授予连接 = T2,由宿主弹窗保障;engine 只记 audit)——
  createChannel(
    input: {
      name: string
      alias: string
      displayName?: string | undefined
      mode?: ChannelMode | undefined
      visibility?: ChannelVisibility | undefined
      description?: string | undefined
      /** 缺省 = 默认 local hub(config.defaultHubPath) */
      home?: string | undefined
    },
    actor: Actor,
  ): Promise<Channel>
  joinChannel(input: { channel: string; alias: string }, actor: Actor): Promise<Channel>
  leaveChannel(input: { channel: string }, actor: Actor): Promise<void>
  listChannels(): Promise<Channel[]>
  listPeers(input?: { channel?: string | undefined }): Promise<Peer[]>
  /** channel 缺省时保留 legacy 的全 membership 发布；Channel runtime 必须传当前会话已激活频道。 */
  publishCard(card: AgentCard, actor: Actor, channel?: string): Promise<void>

  // —— 邀请(T2)——
  createInvite(
    input: CreateInviteInput,
    actor: Actor,
  ): Promise<{ link: string; expiresAt?: string | undefined }>
  /** 兑换邀请链接(connect 工具/join 命令共用) */
  connect(
    input: { link: string; alias: string; card?: AgentCard | undefined },
    actor: Actor,
  ): Promise<ConnectResult>

  // —— 消息(T1,D3 后频道内 send 全 T1)——
  send(input: SendInput, actor: Actor): Promise<SendResult>
  readInbox(input?: ReadInboxInput): Promise<Message[]>
  ack(input: { messageId: string }): Promise<void>

  // —— 同步(F2;read_inbox 内部也会调)——
  syncOnce(channel?: string): Promise<{ pulled: number; pushed: number }>

  // —— T3 治理(人类专属,I4:actor 必须为 'human',否则抛 SCOPE_DENIED)——
  listHeld(channel?: string): Promise<HeldMessage[]>
  deliverHeld(input: { messageId: string; channel?: string | undefined }, actor: Actor): Promise<void>
  dropHeld(input: { messageId: string; channel?: string | undefined }, actor: Actor): Promise<void>
  /** edit:改 held 消息的 payload/contentType 后放行(audit 'edited') */
  editHeld(
    input: {
      messageId: string
      channel?: string | undefined
      payload?: unknown
      contentType?: string | undefined
    },
    actor: Actor,
  ): Promise<void>
  setChannelMode(input: { channel: string; mode: ChannelMode }, actor: Actor): Promise<void>
  auditQuery(q?: AuditQuery): Promise<AuditEntry[]>

  /** 关闭底层连接(测试/CLI 退出) */
  close(): Promise<void>
}

export interface EngineDeps {
  /** Ordered custom bindings (NATS/SLIM/etc.); the first factory accepting the home wins. */
  transportBindingFactories?: TransportBindingFactory[] | undefined
  /** @deprecated HTTPS compatibility hook; use transportBindingFactories for new bindings. */
  relayDriverFactory?: RelayDriverFactory | undefined
  /** 收到新消息时回调(mcp 用于 MCP notification;可选) */
  onInboxChange?: (() => void) | undefined
  inboxCap?: number | undefined
}
