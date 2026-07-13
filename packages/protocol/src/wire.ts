import { z } from 'zod'
import {
  AgentCardSchema,
  AliasSchema,
  ChannelModeSchema,
  ChannelNameSchema,
  InviteScopeSchema,
  MessageEnvelopeSchema,
  MessageSchema,
  NodeIdSchema,
} from './entities.js'
import { ErrorCodes } from './errors.js'

/**
 * relay wire 协议(spec §2.4 + §2.8)。LocalHomeDriver 在文件上实现同构语义。
 * 认证(§2.3):除 GET /j/<token> 外所有端点要求签名头;relay 据 nodeId→pubkey 验签并盖戳 from。
 *
 * 签名规范(canonical string,crypto 模块实现):
 *   `${method}\n${pathWithQuery}\n${tsMs}\n${sha256hex(bodyBytes 或空串)}`
 * Ed25519 签名,base64url。时钟偏移容忍 ±300s。
 */

export const WIRE_HEADERS = {
  node: 'x-agentcomm-node',
  ts: 'x-agentcomm-ts',
  signature: 'x-agentcomm-signature',
} as const

export const wireRoutes = {
  /** POST 批量上行(幂等 by messageId) */
  postMessages: (channel: string) => `/ch/${channel}/messages`,
  /** GET 下行 ?after=<seq>&waitMs=<n>(long-poll)/ SSE: Accept: text/event-stream */
  getMessages: (channel: string) => `/ch/${channel}/messages`,
  /** POST 游标确认 */
  postAck: (channel: string) => `/ch/${channel}/ack`,
  /** POST 兑换邀请入频道 */
  postJoin: '/join',
  /** POST 铸造邀请(成员限定) */
  postInvites: (channel: string) => `/ch/${channel}/invites`,
  /** GET 成员与卡(供 list_peers 同步) */
  getMembers: (channel: string) => `/ch/${channel}/members`,
  /** POST 更新我的卡 */
  postCard: (channel: string) => `/ch/${channel}/card`,
  /** GET 人类引导页(不读 fragment;§2.8) */
  joinPage: (token: string) => `/j/${token}`,
} as const

/** E2E 频道的密文封装:payload+contentType 加密,路由字段明文(§2.5) */
export const CipherPayloadSchema = z.object({
  enc: z.literal('aes-256-gcm'),
  iv: z.string().min(1),
  ct: z.string().min(1),
})
export type CipherPayload = z.infer<typeof CipherPayloadSchema>

/** 上行信封:E2E 频道中 payload 为 CipherPayload 且 contentType 省略 */
export const WireEnvelopeSchema = MessageEnvelopeSchema
export type WireEnvelope = z.infer<typeof WireEnvelopeSchema>

export const PostMessagesReqSchema = z.object({
  messages: z.array(WireEnvelopeSchema).min(1).max(100),
})
export const PostMessagesRespSchema = z.object({
  accepted: z.array(
    z.object({
      messageId: z.string(),
      seq: z.number().int().positive(),
      status: z.enum(['pending', 'held', 'delivered']),
      /** 幂等重放时为 true */
      duplicate: z.boolean().optional(),
    }),
  ),
})

export const GetMessagesQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  waitMs: z.coerce.number().int().min(0).max(60_000).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
export const GetMessagesRespSchema = z.object({
  messages: z.array(MessageSchema),
  /** 当前频道最大 seq(游标推进参考) */
  head: z.number().int().min(0),
})

export const PostAckReqSchema = z.object({ seq: z.number().int().min(0) })
export const PostAckRespSchema = z.object({ ok: z.literal(true) })

export const PostJoinReqSchema = z.object({
  joinToken: z.string().min(1),
  alias: AliasSchema,
  node: z.object({ nodeId: NodeIdSchema, publicKey: z.string().min(1) }),
  card: AgentCardSchema.optional(),
})
export const PostJoinRespSchema = z.object({
  channel: ChannelNameSchema,
  mode: ChannelModeSchema,
  myAlias: AliasSchema,
  members: z.array(z.object({ alias: AliasSchema, nodeId: NodeIdSchema, card: AgentCardSchema.optional() })),
})

export const PostInvitesReqSchema = z.object({
  scope: InviteScopeSchema.optional(),
  ttlMs: z.number().int().positive().optional(),
  maxUses: z.number().int().positive().optional(),
})
export const PostInvitesRespSchema = z.object({
  joinToken: z.string().min(1),
  expiresAt: z.string().optional(),
})

export const GetMembersRespSchema = z.object({
  members: z.array(z.object({ alias: AliasSchema, nodeId: NodeIdSchema, card: AgentCardSchema.optional() })),
})

export const PostCardReqSchema = z.object({ card: AgentCardSchema })
export const PostCardRespSchema = z.object({ ok: z.literal(true) })

export const WireErrorSchema = z.object({
  error: z.object({
    code: z.enum(ErrorCodes),
    message: z.string(),
    /** RATE_LIMITED(破冰限流,D3.2)时:多久后可重试 */
    retryAfterMs: z.number().int().positive().optional(),
  }),
})
export type WireError = z.infer<typeof WireErrorSchema>

/** 破冰限流默认参数(relay 侧,D3.2/EigenFlux 教训) */
export const ICEBREAK_DEFAULTS = {
  /** 新成员在任一其他成员回应前,最多可发消息数 */
  maxBeforeReply: 5,
} as const
