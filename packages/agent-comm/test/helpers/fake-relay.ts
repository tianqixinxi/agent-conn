import { createHash, createPublicKey, verify as edVerify } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { MessageEnvelope } from '@agent-comm/protocol'
import {
  GetMessagesQuerySchema,
  PostAckReqSchema,
  PostCardReqSchema,
  PostCreateChannelReqSchema,
  PostInvitesReqSchema,
  PostJoinReqSchema,
  PostMessagesReqSchema,
} from '@agent-comm/protocol'

/**
 * 测试专用极简 fake relay(node:http,127.0.0.1 随机端口,纯内存态)。
 * 只实现 createRelayDriver 会打的端点(§2.4 三端点 + join/invites/members/card)。
 * 顺手校验三个签名头存在、canonical 可复算(Ed25519 verify 用 node:crypto 直写,不 import
 * crypto/identity.ts —— 那是 W1 的活;也不 import packages/relay —— 那是 W4 的实现,规则不允许)。
 */

export interface FakeRelayNode {
  nodeId: string
  publicKey: string
}

interface StoredMessage {
  seq: number
  envelope: MessageEnvelope
  status: 'pending' | 'held' | 'delivered'
}

interface FakeMember {
  alias: string
  nodeId: string
  publicKey?: string | undefined
  card?: unknown
}

interface FakeChannel {
  mode: 'auto' | 'intercept' | 'paused'
  visibility: 'private' | 'public'
  members: FakeMember[]
  messages: StoredMessage[]
  byMessageId: Map<string, StoredMessage>
  seq: number
  cursors: Map<string, number>
}

export interface RequestLogEntry {
  method: string
  path: string
}

export interface FakeRelay {
  readonly port: number
  readonly url: string
  readonly channels: Map<string, FakeChannel>
  readonly requestLog: RequestLogEntry[]
  /** 直接建频道(绕开 createChannel——relay v1 本就没有远程建频道端点) */
  seedChannel(
    name: string,
    opts?: { mode?: FakeChannel['mode']; visibility?: FakeChannel['visibility'] },
  ): void
  /** 直接注册一个可兑换的 joinToken → channel 映射(绕开真实邀请铸造流程) */
  seedInvite(joinToken: string, channel: string): void
  /** 让某频道下一次 POST messages 返回 429 RATE_LIMITED,消费一次即失效 */
  forceRateLimitOnce(channel: string, retryAfterMs: number): void
  close(): Promise<void>
}

function jsonSend(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

function verifySignedRequest(
  req: IncomingMessage,
  rawBody: string,
  nodeKeys: Map<string, string>,
): { ok: true; nodeId: string } | { ok: false } {
  const nodeId = req.headers['x-agentcomm-node']
  const ts = req.headers['x-agentcomm-ts']
  const sig = req.headers['x-agentcomm-signature']
  if (typeof nodeId !== 'string' || typeof ts !== 'string' || typeof sig !== 'string') {
    return { ok: false }
  }
  const publicKey = nodeKeys.get(nodeId)
  if (!publicKey) return { ok: false }
  const bodyHash = createHash('sha256').update(rawBody, 'utf8').digest('hex')
  const canonical = `${req.method ?? ''}\n${req.url ?? ''}\n${ts}\n${bodyHash}`
  try {
    const pubKeyObj = createPublicKey({
      key: Buffer.from(publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    })
    const okSig = edVerify(null, Buffer.from(canonical, 'utf8'), pubKeyObj, Buffer.from(sig, 'base64url'))
    return okSig ? { ok: true, nodeId } : { ok: false }
  } catch {
    return { ok: false }
  }
}

export function createFakeRelay(nodes: FakeRelayNode[]): Promise<FakeRelay> {
  const nodeKeys = new Map(nodes.map((n) => [n.nodeId, n.publicKey] as const))
  const channels = new Map<string, FakeChannel>()
  const invites = new Map<string, string>()
  const rateLimitOnce = new Map<string, number>()
  const requestLog: RequestLogEntry[] = []

  function newChannel(
    mode: FakeChannel['mode'],
    visibility: FakeChannel['visibility'] = 'private',
  ): FakeChannel {
    return { mode, visibility, members: [], messages: [], byMessageId: new Map(), seq: 0, cursors: new Map() }
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const url = req.url ?? '/'
      requestLog.push({ method: req.method ?? '', path: url })
      const urlObj = new URL(url, 'http://fake-relay.internal')
      const pathname = urlObj.pathname

      const auth = verifySignedRequest(req, rawBody, nodeKeys)
      if (!auth.ok) {
        jsonSend(res, 401, { error: { code: 'AUTH_FAILED', message: 'missing/invalid signature' } })
        return
      }

      let rawJson: unknown
      if (rawBody.length > 0) {
        try {
          rawJson = JSON.parse(rawBody)
        } catch {
          jsonSend(res, 400, { error: { code: 'INVALID_INPUT', message: 'body is not valid JSON' } })
          return
        }
      }

      // POST /join —— 全局端点,joinToken 自带频道信息,path 里没有 channel
      if (req.method === 'POST' && pathname === '/join') {
        const parsed = PostJoinReqSchema.safeParse(rawJson)
        if (!parsed.success) {
          jsonSend(res, 400, { error: { code: 'INVALID_INPUT', message: parsed.error.message } })
          return
        }
        const channelName = invites.get(parsed.data.joinToken)
        if (!channelName) {
          jsonSend(res, 404, { error: { code: 'INVITE_INVALID', message: 'unknown joinToken' } })
          return
        }
        const ch = channels.get(channelName)
        if (!ch) {
          jsonSend(res, 404, { error: { code: 'CHANNEL_NOT_FOUND', message: 'channel missing' } })
          return
        }
        const alreadyMember = ch.members.some((m) => m.nodeId === parsed.data.node.nodeId)
        if (!alreadyMember) {
          ch.members.push({
            alias: parsed.data.alias,
            nodeId: parsed.data.node.nodeId,
            publicKey: parsed.data.node.publicKey,
            card: parsed.data.card,
          })
        }
        jsonSend(res, 200, {
          channel: channelName,
          mode: ch.mode,
          visibility: ch.visibility,
          myAlias: parsed.data.alias,
          members: ch.members.map((m) => ({ alias: m.alias, nodeId: m.nodeId, card: m.card })),
        })
        return
      }

      const segments = pathname.split('/').filter((s) => s.length > 0)
      const channelName = segments[0] === 'ch' ? segments[1] : undefined
      const resource = segments[0] === 'ch' ? segments[2] : undefined
      if (
        segments[0] !== 'ch' ||
        segments.length !== 3 ||
        channelName === undefined ||
        resource === undefined
      ) {
        jsonSend(res, 404, { error: { code: 'NOT_IMPLEMENTED', message: `no route for ${pathname}` } })
        return
      }
      // POST /ch/:c/create —— bootstrap(wire.ts postCreate,D9):频道必须不存在
      if (resource === 'create' && req.method === 'POST') {
        const parsed = PostCreateChannelReqSchema.safeParse(rawJson)
        if (!parsed.success) {
          jsonSend(res, 400, { error: { code: 'INVALID_INPUT', message: parsed.error.message } })
          return
        }
        if (channels.get(channelName)) {
          jsonSend(res, 409, {
            error: { code: 'CHANNEL_EXISTS', message: `channel exists: ${channelName}` },
          })
          return
        }
        const created = newChannel(parsed.data.mode ?? 'auto', parsed.data.visibility ?? 'private')
        created.members.push({
          alias: parsed.data.alias,
          nodeId: parsed.data.node.nodeId,
          publicKey: parsed.data.node.publicKey,
          card: parsed.data.card,
        })
        channels.set(channelName, created)
        jsonSend(res, 200, {
          channel: channelName,
          mode: created.mode,
          visibility: created.visibility,
          myAlias: parsed.data.alias,
          members: created.members.map((m) => ({ alias: m.alias, nodeId: m.nodeId, card: m.card })),
        })
        return
      }

      const ch = channels.get(channelName)
      if (!ch) {
        jsonSend(res, 404, {
          error: { code: 'CHANNEL_NOT_FOUND', message: `unknown channel ${channelName}` },
        })
        return
      }

      if (resource === 'messages' && req.method === 'POST') {
        const forcedRetry = rateLimitOnce.get(channelName)
        if (forcedRetry !== undefined) {
          rateLimitOnce.delete(channelName)
          jsonSend(res, 429, {
            error: { code: 'RATE_LIMITED', message: 'icebreak limit exceeded', retryAfterMs: forcedRetry },
          })
          return
        }
        const parsed = PostMessagesReqSchema.safeParse(rawJson)
        if (!parsed.success) {
          jsonSend(res, 400, { error: { code: 'INVALID_INPUT', message: parsed.error.message } })
          return
        }
        const accepted = parsed.data.messages.map((env) => {
          const existing = ch.byMessageId.get(env.messageId)
          if (existing) {
            return { messageId: env.messageId, seq: existing.seq, status: existing.status, duplicate: true }
          }
          ch.seq += 1
          const status: StoredMessage['status'] = ch.mode === 'intercept' ? 'held' : 'delivered'
          const stored: StoredMessage = { seq: ch.seq, envelope: env, status }
          ch.messages.push(stored)
          ch.byMessageId.set(env.messageId, stored)
          return { messageId: env.messageId, seq: stored.seq, status: stored.status }
        })
        jsonSend(res, 200, { accepted })
        return
      }

      if (resource === 'messages' && req.method === 'GET') {
        const query = GetMessagesQuerySchema.safeParse(Object.fromEntries(urlObj.searchParams))
        if (!query.success) {
          jsonSend(res, 400, { error: { code: 'INVALID_INPUT', message: query.error.message } })
          return
        }
        const visible = ch.messages.filter((m) => m.seq > query.data.after && m.status === 'delivered')
        const page = visible.slice(0, query.data.limit)
        const messages = page.map((m) => ({ ...m.envelope, seq: m.seq, status: m.status }))
        jsonSend(res, 200, { messages, head: ch.seq })
        return
      }

      if (resource === 'ack' && req.method === 'POST') {
        const parsed = PostAckReqSchema.safeParse(rawJson)
        if (!parsed.success) {
          jsonSend(res, 400, { error: { code: 'INVALID_INPUT', message: parsed.error.message } })
          return
        }
        ch.cursors.set(auth.nodeId, parsed.data.seq)
        jsonSend(res, 200, { ok: true })
        return
      }

      if (resource === 'invites' && req.method === 'POST') {
        const parsed = PostInvitesReqSchema.safeParse(rawJson)
        if (!parsed.success) {
          jsonSend(res, 400, { error: { code: 'INVALID_INPUT', message: parsed.error.message } })
          return
        }
        const token = `tok-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
        invites.set(token, channelName)
        jsonSend(res, 200, { joinToken: token })
        return
      }

      if (resource === 'members' && req.method === 'GET') {
        jsonSend(res, 200, {
          members: ch.members.map((m) => ({ alias: m.alias, nodeId: m.nodeId, card: m.card })),
        })
        return
      }

      if (resource === 'card' && req.method === 'POST') {
        const parsed = PostCardReqSchema.safeParse(rawJson)
        if (!parsed.success) {
          jsonSend(res, 400, { error: { code: 'INVALID_INPUT', message: parsed.error.message } })
          return
        }
        const member = ch.members.find((m) => m.nodeId === auth.nodeId)
        if (member) member.card = parsed.data.card
        jsonSend(res, 200, { ok: true })
        return
      }

      jsonSend(res, 404, {
        error: { code: 'NOT_IMPLEMENTED', message: `unhandled ${req.method ?? ''} ${pathname}` },
      })
    })
  })

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('fake relay: unexpected server address'))
        return
      }
      const port = addr.port
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        channels,
        requestLog,
        seedChannel(name, opts) {
          channels.set(name, newChannel(opts?.mode ?? 'auto', opts?.visibility ?? 'private'))
        },
        seedInvite(joinToken, channel) {
          invites.set(joinToken, channel)
        },
        forceRateLimitOnce(channel, retryAfterMs) {
          rateLimitOnce.set(channel, retryAfterMs)
        },
        close() {
          return new Promise((resolveClose) => {
            if (!server.listening) {
              resolveClose()
              return
            }
            server.close(() => resolveClose())
          })
        },
      })
    })
  })
}
