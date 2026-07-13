import {
  AgentCommError,
  GetMembersRespSchema,
  GetMessagesQuerySchema,
  GetMessagesRespSchema,
  isAgentCommError,
  type Message,
  PostAckReqSchema,
  PostAckRespSchema,
  PostCardReqSchema,
  PostCardRespSchema,
  PostCreateChannelReqSchema,
  PostCreateChannelRespSchema,
  PostInvitesReqSchema,
  PostInvitesRespSchema,
  PostJoinReqSchema,
  PostJoinRespSchema,
  PostMessagesReqSchema,
  PostMessagesRespSchema,
} from '@agent-comm/protocol'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { createAuthMiddleware, requireHeaderNode } from './auth.js'
import { errorStatus } from './http.js'
import { renderJoinPage } from './join-page.js'
import type { RelayDb } from './store.js'
import {
  ackCursor,
  appendMessages,
  createChannelBootstrap,
  createInvite,
  joinViaInvite,
  listMembers,
  memberRowToWire,
  openDb,
  pullMessages,
  requireMember,
  updateCard,
} from './store.js'

/**
 * W4 实现处:邮箱中继(§2.4/§4.2/D3.2)。职责清单见 packages/relay/src/store.ts 与
 * packages/relay/src/auth.ts 顶部注释;本文件只做 HTTP 层转译(路由/参数解析/zod 校验/
 * 错误码→状态码),业务规则全在 store.ts。
 *
 * ——— POST /ch/:channel/create(bootstrap 建频道)———
 * wire.ts 的 /invites 隐含"调用者已是成员",全新频道需要一个 bootstrap 入口:
 * 只在频道尚不存在时可用(已存在→409 CHANNEL_EXISTS),调用者成为首个成员;
 * 鉴权与 POST /join 同构(首次露面节点用 body.node.publicKey 做 TOFU 验签,见 auth.ts)。
 * 该端点最初由 W4 本地定义,集成收口时已回填为 protocol/wire.ts 正式契约(DECISIONS D9),
 * schema 从 @agent-comm/protocol 导入。
 */

export interface RelayDeps {
  dbPath: string
}

type Handler = (c: Context) => Promise<Response>

/** 统一把 AgentCommError 转成 WireErrorSchema + 语义化状态码;未预期错误兜底 503 并打 stderr */
function withErrors(handler: Handler): Handler {
  return async (c) => {
    try {
      return await handler(c)
    } catch (e) {
      if (isAgentCommError(e)) {
        const detail = e.detail as { retryAfterMs?: number } | undefined
        return c.json(
          {
            error: {
              code: e.code,
              message: e.message,
              ...(detail?.retryAfterMs !== undefined ? { retryAfterMs: detail.retryAfterMs } : {}),
            },
          },
          errorStatus(e.code),
        )
      }
      // ErrorCodes(protocol/errors.ts)没有通用的"内部错误"码;503 STORE_BUSY 是最接近的
      // 语义(存储层出了意料外的问题,建议重试)。正常路径不应该走到这里。
      process.stderr.write(
        `agent-comm relay: unexpected error: ${e instanceof Error ? e.stack : String(e)}\n`,
      )
      return c.json({ error: { code: 'STORE_BUSY', message: 'internal error' } }, 503)
    }
  }
}

/** 读原始 body 并 JSON.parse;空 body 返回 undefined(留给 zod schema 的必填校验去拒绝) */
async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new AgentCommError('INVALID_INPUT', 'request body is not valid JSON')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * :channel 路径段。handler 的类型是通用 `Context`(不绑定具体路由 pattern),所以
 * `c.req.param('channel')` 在类型上是 `string | undefined`;实际路由匹配上就必然有值,
 * 这里只是满足 strict null checks,INVALID_INPUT 分支正常不会被触发。
 */
function requireChannelParam(c: Context): string {
  const channel = c.req.param('channel')
  if (!channel) throw new AgentCommError('INVALID_INPUT', 'missing :channel path param')
  return channel
}

/** GET /ch/:channel/messages 的 long-poll:没货且 waitMs>0 时,按 500ms 间隔轮询 db 直到有货或超时 */
const LONG_POLL_INTERVAL_MS = 500

async function pullWithLongPoll(
  db: RelayDb,
  channel: string,
  after: number,
  limit: number,
  waitMs: number,
): Promise<{ messages: Message[]; head: number }> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const result = pullMessages(db, { channel, after, limit })
    if (result.messages.length > 0 || waitMs <= 0) return result
    const remaining = deadline - Date.now()
    if (remaining <= 0) return result
    await sleep(Math.min(LONG_POLL_INTERVAL_MS, remaining))
  }
}

export function createApp(deps: RelayDeps): Hono {
  const db = openDb(deps.dbPath)
  const app = new Hono()

  // 除 GET /j/:token、GET /healthz 外全部要求 WIRE_HEADERS 签名(auth.ts 内部判断路径豁免)
  app.use('*', createAuthMiddleware(db))

  app.get('/healthz', (c) => c.json({ ok: true }))

  // §2.8:人类引导页,不读 fragment、不判断 token 有效性(join-page.ts 顶部注释)
  app.get('/j/:token', (c) => c.html(renderJoinPage()))

  app.post(
    '/join',
    withErrors(async (c) => {
      const headerNodeId = requireHeaderNode(c)
      const body = await readJson(c)
      const parsed = PostJoinReqSchema.safeParse(body)
      if (!parsed.success) throw new AgentCommError('INVALID_INPUT', parsed.error.message)
      if (parsed.data.node.nodeId !== headerNodeId) {
        throw new AgentCommError('AUTH_FAILED', 'x-agentcomm-node header 与 body.node.nodeId 不一致')
      }
      const result = joinViaInvite(db, {
        joinToken: parsed.data.joinToken,
        alias: parsed.data.alias,
        nodeId: parsed.data.node.nodeId,
        publicKey: parsed.data.node.publicKey,
        card: parsed.data.card,
      })
      return c.json(PostJoinRespSchema.parse(result))
    }),
  )

  // bootstrap 建频道(wire.ts postCreate,D9 回填后的正式契约)
  app.post(
    '/ch/:channel/create',
    withErrors(async (c) => {
      const channel = requireChannelParam(c)
      const headerNodeId = requireHeaderNode(c)
      const body = await readJson(c)
      const parsed = PostCreateChannelReqSchema.safeParse(body)
      if (!parsed.success) throw new AgentCommError('INVALID_INPUT', parsed.error.message)
      if (parsed.data.node.nodeId !== headerNodeId) {
        throw new AgentCommError('AUTH_FAILED', 'x-agentcomm-node header 与 body.node.nodeId 不一致')
      }
      const result = createChannelBootstrap(db, {
        channel,
        alias: parsed.data.alias,
        nodeId: parsed.data.node.nodeId,
        publicKey: parsed.data.node.publicKey,
        mode: parsed.data.mode,
        displayName: parsed.data.displayName,
        description: parsed.data.description,
        card: parsed.data.card,
      })
      return c.json(PostCreateChannelRespSchema.parse(result))
    }),
  )

  app.post(
    '/ch/:channel/invites',
    withErrors(async (c) => {
      const channel = requireChannelParam(c)
      const nodeId = requireHeaderNode(c)
      // 严格按契约:调用者必须已是成员;频道不存在→404(不做隐式建频道,见文件顶部注释)
      requireMember(db, channel, nodeId)
      const body = await readJson(c)
      const parsed = PostInvitesReqSchema.safeParse(body ?? {})
      if (!parsed.success) throw new AgentCommError('INVALID_INPUT', parsed.error.message)
      const result = createInvite(db, {
        channel,
        scope: parsed.data.scope,
        ttlMs: parsed.data.ttlMs,
        maxUses: parsed.data.maxUses,
        createdByNode: nodeId,
      })
      return c.json(PostInvitesRespSchema.parse(result))
    }),
  )

  app.post(
    '/ch/:channel/messages',
    withErrors(async (c) => {
      const channel = requireChannelParam(c)
      const nodeId = requireHeaderNode(c)
      const body = await readJson(c)
      const parsed = PostMessagesReqSchema.safeParse(body)
      if (!parsed.success) throw new AgentCommError('INVALID_INPUT', parsed.error.message)
      for (const env of parsed.data.messages) {
        if (env.channel !== channel) {
          throw new AgentCommError(
            'INVALID_INPUT',
            `envelope.channel(${env.channel}) 与路径 channel(${channel}) 不一致`,
          )
        }
      }
      const results = appendMessages(db, { channel, nodeId, envelopes: parsed.data.messages })
      return c.json(PostMessagesRespSchema.parse({ accepted: results }))
    }),
  )

  app.get(
    '/ch/:channel/messages',
    withErrors(async (c) => {
      const channel = requireChannelParam(c)
      const nodeId = requireHeaderNode(c)
      requireMember(db, channel, nodeId)
      const url = new URL(c.req.url)
      const parsedQuery = GetMessagesQuerySchema.safeParse(Object.fromEntries(url.searchParams))
      if (!parsedQuery.success) throw new AgentCommError('INVALID_INPUT', parsedQuery.error.message)
      const { after, waitMs, limit } = parsedQuery.data
      const result = await pullWithLongPoll(db, channel, after, limit, waitMs)
      return c.json(GetMessagesRespSchema.parse(result))
    }),
  )

  app.post(
    '/ch/:channel/ack',
    withErrors(async (c) => {
      const channel = requireChannelParam(c)
      const nodeId = requireHeaderNode(c)
      const body = await readJson(c)
      const parsed = PostAckReqSchema.safeParse(body)
      if (!parsed.success) throw new AgentCommError('INVALID_INPUT', parsed.error.message)
      ackCursor(db, { channel, nodeId, seq: parsed.data.seq })
      return c.json(PostAckRespSchema.parse({ ok: true }))
    }),
  )

  app.get(
    '/ch/:channel/members',
    withErrors(async (c) => {
      const channel = requireChannelParam(c)
      const nodeId = requireHeaderNode(c)
      requireMember(db, channel, nodeId)
      const members = listMembers(db, channel).map(memberRowToWire)
      return c.json(GetMembersRespSchema.parse({ members }))
    }),
  )

  app.post(
    '/ch/:channel/card',
    withErrors(async (c) => {
      const channel = requireChannelParam(c)
      const nodeId = requireHeaderNode(c)
      const body = await readJson(c)
      const parsed = PostCardReqSchema.safeParse(body)
      if (!parsed.success) throw new AgentCommError('INVALID_INPUT', parsed.error.message)
      updateCard(db, { channel, nodeId, card: parsed.data.card })
      return c.json(PostCardRespSchema.parse({ ok: true }))
    }),
  )

  app.all('*', (c) =>
    c.json(
      {
        error: {
          code: 'NOT_IMPLEMENTED',
          message: `relay: 未知路由 ${c.req.method} ${new URL(c.req.url).pathname}`,
        },
      },
      501,
    ),
  )

  return app
}
