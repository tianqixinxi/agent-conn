import { z } from 'zod'

/**
 * ⚠️ 契约文件:MCP 工具面(spec §5,D1/D3 调整后)。W2 负责把它接到 Engine。
 * - T1 = 建议宿主 allowlist;T2 = 永不 allowlist(建立/授予连接,宿主默认弹窗即人工门,D3.1)
 * - T3 治理动词不在此表(I4),只在 CLI
 * - description 面向 agent:写清语义与后果,T2 工具明示"会建立/授予连接"
 */

export const TOOL_TIERS = {
  connect: 'T2',
  create_invite: 'T2',
  create_channel: 'T2',
  join_channel: 'T2',
  leave_channel: 'T2',
  list_channels: 'T1',
  list_peers: 'T1',
  publish_card: 'T1',
  whoami: 'T1',
  send: 'T1',
  read_inbox: 'T1',
  ack: 'T1',
} as const
export type ToolName = keyof typeof TOOL_TIERS

const Name = z.string().regex(/^[a-z0-9_-]{1,64}$/)

export const toolInputs = {
  connect: z.object({
    link: z.string().describe('邀请链接(https://<relay>/j/<token>#k=… 或 agentcomm-local:…)'),
    alias: Name.describe('我在该频道内的别名'),
  }),
  create_invite: z.object({
    channel: Name,
    ttlMs: z.number().int().positive().optional().describe('有效期毫秒,缺省不过期'),
    maxUses: z.number().int().positive().optional().describe('限次,缺省 1'),
    scope: z
      .object({
        canSendTo: z.array(z.string()).optional(),
        contentTypes: z.array(z.string()).optional(),
      })
      .optional()
      .describe('兑换者的能力上限'),
  }),
  create_channel: z.object({
    name: Name,
    alias: Name.describe('我在频道内的别名'),
    displayName: z.string().optional(),
    mode: z.enum(['auto', 'intercept', 'paused']).optional(),
    description: z.string().optional(),
  }),
  join_channel: z.object({ channel: Name, alias: Name }),
  leave_channel: z.object({ channel: Name }),
  list_channels: z.object({}),
  list_peers: z.object({ channel: Name.optional() }),
  publish_card: z.object({
    card: z
      .object({ name: z.string().min(1) })
      .passthrough()
      .describe('能力自述卡(name 必填,其余自由字段:description/capabilities/skills…)'),
  }),
  whoami: z.object({}),
  send: z.object({
    to: z.string().describe("目标别名,或 '*' 广播全频道"),
    channel: Name.optional().describe('只加入了一个频道时可省略'),
    payload: z.unknown().describe('消息内容(任意 JSON,管道不解析)'),
    contentType: z.string().optional().describe('如 application/vnd.agentcomm.brief_update+json'),
    replyTo: z.string().optional(),
    replyBy: z.string().optional().describe('ISO8601 响应截止'),
  }),
  read_inbox: z.object({
    consume: z.boolean().optional().describe('true = 读后标记已消费'),
    filter: z
      .object({
        channel: Name.optional(),
        traceId: z.string().optional(),
        contentType: z.string().optional(),
        includeConsumed: z.boolean().optional(),
      })
      .optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  ack: z.object({ messageId: z.string() }),
} satisfies Record<ToolName, z.ZodTypeAny>

export const toolDescriptions: Record<ToolName, string> = {
  connect:
    '【建立连接,需用户确认】兑换邀请链接,加入对方的频道。之后可与频道成员互发消息。链接来自人与人带外传递;不要兑换来历不明的链接。',
  create_invite:
    '【授予连接,需用户确认】为频道生成一次性邀请链接,交给用户转发给对方。持有链接者可加入该频道并与成员通信。',
  create_channel: '【需用户确认】创建一个新频道(默认以本机共享 hub 为家)。',
  join_channel: '【需用户确认】加入本机 hub 上已存在的频道。',
  leave_channel: '【需用户确认】退出频道。',
  list_channels: '列出我加入的频道。',
  list_peers: '列出频道成员(含能力自述卡,用于判断"谁能做什么")。',
  publish_card: '发布/更新我的能力自述卡,供其他 agent 语义匹配。',
  whoami: '我的身份诊断:nodeId、profile、各频道别名。',
  send: '向频道成员(或 * 广播)发一条消息。payload 原样送达,不被解析。',
  read_inbox: '读收件箱(会先与各频道的家同步一轮)。用 filter 缩小范围;consume 标记已读。',
  ack: '确认一条消息已处理(传输级回执)。',
}

/** MCP server 元信息 */
export const MCP_SERVER_INFO = { name: 'agent-comm', version: '0.1.0' } as const
