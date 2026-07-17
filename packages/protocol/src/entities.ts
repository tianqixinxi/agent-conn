import { z } from 'zod'
import { NAME_RE } from './ids.js'

/**
 * 实体 schema(spec §3,已按 DECISIONS.md D1/D5 调整):
 * - 身份锚 = nodeId(profile),不存在 sessionId 字段
 * - Channel.home = 'local:<hub 文件绝对路径>' 或 relay 的 https URL
 * - payload / contentType / card 对 L0 不透明(I1):这里只透传,不校验内容
 */

export const AliasSchema = z.string().regex(NAME_RE)
export const ChannelNameSchema = z.string().regex(NAME_RE)
export const MessageIdSchema = z.string().min(3).max(128)
export const NodeIdSchema = z.string().min(3).max(128)
export const IsoSchema = z.string().datetime({ offset: true }).or(z.string().datetime())

/** 频道的家:排序权威 + 门的位置(§2.2,D5) */
export const HomeSchema = z
  .string()
  .refine(
    (s) =>
      s.startsWith('local:') ||
      s.startsWith('https://') ||
      s.startsWith('http://') ||
      s.startsWith('nats://') ||
      s.startsWith('slim://'),
    { message: "home must be 'local:<abs-path>' or a supported transport URL" },
  )
export type Home = z.infer<typeof HomeSchema>

export const ChannelModeSchema = z.enum(['auto', 'intercept', 'paused'])
export type ChannelMode = z.infer<typeof ChannelModeSchema>

/** Private channels are E2E encrypted; public channels are plaintext and browser-readable. */
export const ChannelVisibilitySchema = z.enum(['private', 'public'])
export type ChannelVisibility = z.infer<typeof ChannelVisibilitySchema>

export const MsgStatusSchema = z.enum(['pending', 'held', 'delivered', 'dropped'])
export type MsgStatus = z.infer<typeof MsgStatusSchema>

/** 能力自述卡:LLM 读它做语义匹配;L0 只存/返,唯一约定 name 必填(R5) */
export const AgentCardSchema = z.object({ name: z.string().min(1) }).passthrough()
export type AgentCard = z.infer<typeof AgentCardSchema>

export const InviteScopeSchema = z.object({
  canSendTo: z.array(AliasSchema.or(z.literal('*'))).optional(),
  contentTypes: z.array(z.string()).optional(),
  /** v1 记录不强制(见 DESIGN §3 store 边界说明) */
  readInbox: z.boolean().optional(),
})
export type InviteScope = z.infer<typeof InviteScopeSchema>

export const ChannelMemberSchema = z.object({
  alias: AliasSchema,
  nodeId: NodeIdSchema,
  joinedAt: IsoSchema,
  scope: InviteScopeSchema.optional(),
  card: AgentCardSchema.optional(),
})
export type ChannelMember = z.infer<typeof ChannelMemberSchema>

export const ChannelSchema = z.object({
  name: ChannelNameSchema,
  home: HomeSchema,
  displayName: z.string().optional(),
  mode: ChannelModeSchema.default('auto'),
  visibility: ChannelVisibilitySchema.default('private'),
  description: z.string().optional(),
  createdAt: IsoSchema,
})
export type Channel = z.infer<typeof ChannelSchema>

export const PeerSchema = z.object({
  alias: AliasSchema,
  nodeId: NodeIdSchema,
  channel: ChannelNameSchema,
  online: z.boolean().optional(),
  card: AgentCardSchema.optional(),
})
export type Peer = z.infer<typeof PeerSchema>

export const HOP_LIMIT = 50

/** 发送时组装的信封(家赋 seq 之前) */
export const MessageEnvelopeSchema = z.object({
  messageId: MessageIdSchema,
  from: AliasSchema,
  to: AliasSchema.or(z.literal('*')),
  channel: ChannelNameSchema,
  traceId: z.string().min(1),
  replyTo: MessageIdSchema.optional(),
  replyBy: IsoSchema.optional(),
  hop: z.number().int().min(0).max(HOP_LIMIT),
  contentType: z.string().optional(),
  /** 不透明(I1);E2E 频道上行时替换为密文封装,见 wire.ts */
  payload: z.unknown(),
  injectedByHuman: z.boolean(),
  ts: IsoSchema,
})
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>

/** 家处理后的完整消息 */
export const MessageSchema = MessageEnvelopeSchema.extend({
  seq: z.number().int().positive().optional(),
  status: MsgStatusSchema,
  deliveredAt: IsoSchema.optional(),
  deliveredTo: z.array(AliasSchema).optional(),
})
export type Message = z.infer<typeof MessageSchema>

export const InviteSchema = z.object({
  link: z.string().min(1),
  home: HomeSchema,
  channel: ChannelNameSchema,
  scope: InviteScopeSchema.optional(),
  expiresAt: IsoSchema.optional(),
  maxUses: z.number().int().positive().optional(),
  uses: z.number().int().min(0).default(0),
})
export type Invite = z.infer<typeof InviteSchema>

export const NodeIdentitySchema = z.object({
  nodeId: NodeIdSchema,
  /** base64url 编码的 Ed25519 SPKI 公钥 */
  publicKey: z.string().min(1),
  /** 本地私钥文件引用;私钥本体不入库(§4.1) */
  privateKeyRef: z.string().min(1),
  relays: z.array(z.string()).default([]),
})
export type NodeIdentity = z.infer<typeof NodeIdentitySchema>

export const SyncStateSchema = z.object({
  channel: ChannelNameSchema,
  lastSeqSynced: z.number().int().min(0),
})
export type SyncState = z.infer<typeof SyncStateSchema>

export const AuditEventSchema = z.enum([
  'created',
  'injected',
  'delivered',
  'held',
  'dropped',
  'edited',
  'connected',
])
export type AuditEvent = z.infer<typeof AuditEventSchema>

/** actor: 'human' 或 `agent:<alias>`(I4/I6) */
export const ActorSchema = z.string().refine((s) => s === 'human' || s.startsWith('agent:'), {
  message: "actor must be 'human' or 'agent:<alias>'",
})

export const AuditEntrySchema = z.object({
  ts: IsoSchema,
  event: AuditEventSchema,
  messageId: MessageIdSchema.optional(),
  channel: ChannelNameSchema.optional(),
  from: AliasSchema.optional(),
  to: z.string().optional(),
  actor: ActorSchema,
  detail: z.string().optional(),
})
export type AuditEntry = z.infer<typeof AuditEntrySchema>

// —— 审批(§7,M3;D2:托管审批走明文侧信道,不经 E2E 频道)——

export const PendingApprovalSchema = z.object({
  id: z.string().min(1),
  messageId: MessageIdSchema,
  requester: AliasSchema,
  approver: AliasSchema,
  action: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  allowAccept: z.boolean().optional(),
  allowEdit: z.boolean().optional(),
  allowReject: z.boolean().optional(),
  status: z.enum(['pending', 'decided', 'expired']),
  expiresAt: IsoSchema.optional(),
  createdAt: IsoSchema,
})
export type PendingApproval = z.infer<typeof PendingApprovalSchema>

export const SignedDecisionSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['accept', 'edit', 'reject']),
  args: z.record(z.string(), z.unknown()).optional(),
  approver: z.object({
    id: z.string().min(1),
    method: z.enum(['oauth', 'passkey', 'magic-link', 'sigstore']),
  }),
  signature: z.string().min(1),
  signedAt: IsoSchema,
})
export type SignedDecision = z.infer<typeof SignedDecisionSchema>
