import { createHash } from 'node:crypto'
import {
  AgentCommError,
  GetMembersRespSchema,
  GetMessagesRespSchema,
  PostAckRespSchema,
  PostCardRespSchema,
  PostCreateChannelRespSchema,
  PostInvitesRespSchema,
  PostJoinRespSchema,
  PostMessagesRespSchema,
  WIRE_HEADERS,
  WireErrorSchema,
  wireRoutes,
} from '@agent-comm/protocol'
import type { RelayDriverFactory, TransportBinding } from '../transport/api.js'
import { normalizeRelayOrigin, safeRelayRequest } from './safe-relay-request.js'

/**
 * W3 实现处:relay 家驱动(§2.4 客户端,M2)。
 * - fetch(Node 内建)实现 wire.ts 三端点 + join/invites/members/card;签名头见 WIRE_HEADERS
 * - append 前若频道有 e2eKey:crypto/e2e.seal 替换 payload(contentType 併入密文)——由 with-e2e.ts 的
 *   withE2e() 包装器在这一层之上完成(RelayDriverFactory 签名没有 e2eKey 位置,见最终汇报)
 * - pullAfter 后对 CipherPayload 解封再交回 engine——同上,交给 withE2e()
 * - 网络失败抛 HOME_UNREACHABLE(engine 保消息于 outbox,下轮重试;I3)
 * - SSE 存活期推送(§2.6)与 long-poll 二选一,v1 先短轮询:pullAfter 不传 waitMs,取服务端默认 0
 *
 * 端点映射(DESIGN §6 W3 工单原文):
 * - createChannel → v1 relay 无远程建频道端点(wire.ts 无对应路由),抛 NOT_IMPLEMENTED;建频道走邀请流
 * - join → POST /join;leave → wire.ts 无端点,按本地语义处理(no-op,成员移除交给 engine 本地 store)
 * - mintInvite → POST /ch/:c/invites;members → GET /ch/:c/members;updateCard → POST /ch/:c/card
 * - append → POST /ch/:c/messages(≤100 条/批,自动分批);pullAfter → GET ?after&limit
 * - ackCursor → POST /ch/:c/ack
 * - listHeld/resolveHeld/setMode → v1 relay 无远程门端点,抛 NOT_IMPLEMENTED(门在 M3)
 *
 * 错误映射:网络失败/5xx → HOME_UNREACHABLE;非 2xx 且响应体是 WireErrorSchema → 还原对应
 * AgentCommError(RATE_LIMITED 的 retryAfterMs 进 detail);非 2xx 且无法解析错误体 → HOME_UNREACHABLE。
 * 所有成功响应也过 zod 解析,解析失败同样视为 HOME_UNREACHABLE(家返回了不符合契约的数据)。
 *
 * at-least-once(I3):append 幂等靠 messageId,relay 的 duplicate 标记原样透传;
 * 驱动本身不做重试循环——outbox 断网重试是 engine 的事,这里只负责单次请求的成败判断。
 */

/** 每批最多消息数,对齐 wire.ts PostMessagesReqSchema 的 `.max(100)` */
const MAX_APPEND_BATCH = 100

/** 自己拼 query string(不用 URLSearchParams 二次编码),保证签名串与实际请求串字节一致 */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.join('&')
}

/** 非 2xx 响应:优先按 WireErrorSchema 还原;解析不出结构化错误体则视为家不可达 */
function toAgentCommError(body: unknown, status: number): AgentCommError {
  const parsed = WireErrorSchema.safeParse(body)
  if (parsed.success) {
    const { code, message, retryAfterMs } = parsed.data.error
    return new AgentCommError(code, message, retryAfterMs !== undefined ? { retryAfterMs } : undefined)
  }
  return new AgentCommError('HOME_UNREACHABLE', `relay 返回 ${status} 且无结构化错误体`, { status })
}

export const createRelayDriver: RelayDriverFactory = (input) => {
  const { relayUrl, identity, signRequest } = input
  const base = normalizeRelayOrigin(relayUrl)

  /** 统一请求执行:签名 + 发起 + 状态码分派 + zod 解析 */
  async function call<T>(
    method: 'GET' | 'POST',
    pathWithQuery: string,
    body: unknown,
    schema: { parse: (v: unknown) => T },
  ): Promise<T> {
    const bodyStr = body === undefined ? '' : JSON.stringify(body)
    const tsMs = String(Date.now())
    const bodyHash = createHash('sha256').update(bodyStr, 'utf8').digest('hex')
    const canonical = `${method}\n${pathWithQuery}\n${tsMs}\n${bodyHash}`

    let signature: string
    try {
      signature = await signRequest(canonical)
    } catch (err) {
      throw new AgentCommError('AUTH_FAILED', 'signRequest 回调失败,无法对 relay 请求签名', err)
    }

    let res: Awaited<ReturnType<typeof safeRelayRequest>>
    try {
      res = await safeRelayRequest(
        base,
        method,
        pathWithQuery,
        {
          'content-type': 'application/json',
          [WIRE_HEADERS.node]: identity.nodeId,
          [WIRE_HEADERS.ts]: tsMs,
          [WIRE_HEADERS.signature]: signature,
        },
        body === undefined ? undefined : bodyStr,
      )
    } catch (err) {
      throw new AgentCommError('HOME_UNREACHABLE', `relay 不可达: ${(err as Error).message}`, err)
    }

    const text = res.text
    let json: unknown
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
    }

    if (!res.ok) {
      if (res.status >= 500) {
        throw new AgentCommError('HOME_UNREACHABLE', `relay 5xx: ${res.status}`, { status: res.status })
      }
      throw toAgentCommError(json, res.status)
    }

    try {
      return schema.parse(json)
    } catch (err) {
      throw new AgentCommError('HOME_UNREACHABLE', 'relay 响应不符合 wire schema', err)
    }
  }

  const driver: TransportBinding = {
    kind: 'relay',
    home: base,

    async createChannel(createInput) {
      // bootstrap 端点(wire.ts postCreate,D9 回填):创建频道并成为首个成员
      const body = {
        alias: createInput.member.alias,
        mode: createInput.mode,
        visibility: createInput.visibility,
        displayName: createInput.displayName,
        description: createInput.description,
        card: createInput.member.card,
        node: {
          nodeId: createInput.member.nodeId,
          publicKey: createInput.member.publicKey ?? identity.publicKey,
        },
      }
      await call('POST', wireRoutes.postCreate(createInput.name), body, PostCreateChannelRespSchema)
    },

    async join(joinInput) {
      const body = {
        joinToken: joinInput.joinToken,
        alias: joinInput.member.alias,
        node: {
          nodeId: joinInput.member.nodeId,
          // wire 的 PostJoinReqSchema.node.publicKey 必填;TransportBinding 契约里是可选字段,
          // 缺省回退到驱动自身身份的公钥(加入者就是这个节点自己)
          publicKey: joinInput.member.publicKey ?? identity.publicKey,
        },
        card: joinInput.member.card,
      }
      const resp = await call('POST', wireRoutes.postJoin, body, PostJoinRespSchema)
      // wire 的 PostJoinRespSchema 不携带 scope 字段(契约问题,见最终汇报);此处恒为 undefined。
      return {
        channel: resp.channel,
        mode: resp.mode,
        visibility: resp.visibility,
        members: resp.members,
        scope: undefined,
      }
    },

    async leave() {
      // wire.ts 未定义 leave 端点(§2.4 三端点里没有);relay 家按“本地语义”处理:不发请求,直接成功。
      // 成员离开的记账(store 里的 membership 行、home 端要不要感知)留给 engine 在本地处理。
      return
    },

    async mintInvite(mintInput) {
      const body = { scope: mintInput.scope, ttlMs: mintInput.ttlMs, maxUses: mintInput.maxUses }
      return call('POST', wireRoutes.postInvites(mintInput.channel), body, PostInvitesRespSchema)
    },

    async members(channel) {
      const resp = await call('GET', wireRoutes.getMembers(channel), undefined, GetMembersRespSchema)
      return resp.members
    },

    async updateCard(updateInput) {
      await call(
        'POST',
        wireRoutes.postCard(updateInput.channel),
        { card: updateInput.card },
        PostCardRespSchema,
      )
    },

    async append(channel, envelopes) {
      const results: Awaited<ReturnType<TransportBinding['append']>> = []
      for (let i = 0; i < envelopes.length; i += MAX_APPEND_BATCH) {
        const batch = envelopes.slice(i, i + MAX_APPEND_BATCH)
        const resp = await call(
          'POST',
          wireRoutes.postMessages(channel),
          { messages: batch },
          PostMessagesRespSchema,
        )
        results.push(...resp.accepted)
      }
      return results
    },

    async pullAfter(channel, after, opts) {
      const qs = buildQuery({ after, limit: opts?.limit })
      const path =
        qs.length > 0 ? `${wireRoutes.getMessages(channel)}?${qs}` : wireRoutes.getMessages(channel)
      return call('GET', path, undefined, GetMessagesRespSchema)
    },

    async ackCursor(channel, _nodeId, seq) {
      await call('POST', wireRoutes.postAck(channel), { seq }, PostAckRespSchema)
    },

    async listHeld() {
      throw new AgentCommError('NOT_IMPLEMENTED', 'relay 家 v1 不支持远程门(listHeld);门在 M3')
    },
    async resolveHeld() {
      throw new AgentCommError('NOT_IMPLEMENTED', 'relay 家 v1 不支持远程门(resolveHeld);门在 M3')
    },
    async setMode() {
      throw new AgentCommError('NOT_IMPLEMENTED', 'relay 家 v1 不支持远程门(setMode);门在 M3')
    },

    async close() {
      // v1 短轮询(非 SSE/long-poll 常驻连接),没有需要关闭的持久连接
      return
    },
  }

  return driver
}
