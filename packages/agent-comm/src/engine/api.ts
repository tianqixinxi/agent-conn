import type {
  AgentCard,
  AuditEntry,
  Channel,
  ChannelMode,
  InviteScope,
  Message,
  MessageEnvelope,
  NodeIdentity,
  Peer,
} from '@agent-comm/protocol'

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
  publishCard(card: AgentCard, actor: Actor): Promise<void>

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
  deliverHeld(input: { messageId: string }, actor: Actor): Promise<void>
  dropHeld(input: { messageId: string }, actor: Actor): Promise<void>
  /** edit:改 held 消息的 payload/contentType 后放行(audit 'edited') */
  editHeld(
    input: { messageId: string; payload?: unknown; contentType?: string | undefined },
    actor: Actor,
  ): Promise<void>
  setChannelMode(input: { channel: string; mode: ChannelMode }, actor: Actor): Promise<void>
  auditQuery(q?: AuditQuery): Promise<AuditEntry[]>

  /** 关闭底层连接(测试/CLI 退出) */
  close(): Promise<void>
}

/**
 * 家驱动(§2.2/D5):一频道一家。local 驱动在 engine 内(W1);
 * relay 驱动由 sync 模块实现并经 EngineDeps 注入(W3)。
 */
export interface HomeDriver {
  readonly kind: 'local' | 'relay'
  readonly home: string

  /** 建频道(家侧权威记录);已存在则 CHANNEL_EXISTS */
  createChannel(input: {
    name: string
    displayName?: string | undefined
    mode?: ChannelMode | undefined
    description?: string | undefined
    member: { alias: string; nodeId: string; publicKey?: string | undefined; card?: AgentCard | undefined }
  }): Promise<void>

  /**
   * 入频道(alias 唯一,冲突 ALIAS_TAKEN;joinToken 兑换在家侧计数/过期)。
   * channel 仅供日志/诊断:两种家都由 joinToken 反查权威频道名,返回值以家的响应为准
   * (W1/W3 均已按此实现;字段保留为 optional 是为了调用方语境自述,不参与路由)。
   */
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

  /**
   * 追加消息(家赋 seq;幂等 by messageId,重复返回 duplicate)。
   * mode=intercept → status 'held';mode=paused → RATE_LIMITED 拒收。
   */
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

  /** 拉取 seq > after 的已放行消息(held/dropped 不下发) */
  pullAfter(
    channel: string,
    after: number,
    opts?: { limit?: number | undefined },
  ): Promise<{ messages: Message[]; head: number }>

  ackCursor(channel: string, nodeId: string, seq: number): Promise<void>

  // —— 门(T3;局部于家)——
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

/** relay 家驱动工厂签名(W3 实现;engine 用它打开 https home) */
export type RelayDriverFactory = (input: {
  relayUrl: string
  identity: NodeIdentity
  signRequest: (canonical: string) => Promise<string>
}) => HomeDriver

export interface EngineDeps {
  /** 缺省用内建 LocalHomeDriver 打开 'local:' 家;https 家经 relayDriverFactory */
  relayDriverFactory?: RelayDriverFactory | undefined
  /** 收到新消息时回调(mcp 用于 MCP notification;可选) */
  onInboxChange?: (() => void) | undefined
  inboxCap?: number | undefined
}
