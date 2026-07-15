import { createHash } from 'node:crypto'
import type { AgentCard, Message, MessageEnvelope, MsgStatus } from '@agent-comm/protocol'
import { AgentCommError, newJoinToken, nowIso } from '@agent-comm/protocol'
import type { HubMemberRow, HubMessageRow } from '../store/index.js'
import { openHubDb } from '../store/index.js'
import type { TransportBinding } from '../transport/api.js'

/**
 * W1 实现处:local 家驱动(D5)。
 * - 打开(必要时初始化)共享 hub 文件(store/schema.hub.sql)
 * - append:单事务内 seq = COALESCE(MAX(seq),0)+1;messageId 幂等(重复返回既有 seq + duplicate:true)
 * - intercept:status='held' 停在家;resolveHeld 放行/丢弃(hub_audit 记录)
 * - pullAfter:只下发已放行消息;held 消息构成"游标屏障"——见下方 pullAfter 注释
 * - busy_timeout >= 2000ms(sqlite.ts 的 openDb 设了 5000ms);所有多语句写包事务
 *
 * 关于 TransportBinding.join() 的 `channel` 入参:
 * local 邀请链接(agentcomm-local:?path=&t=)与 relay 的 PostJoinReqSchema 一样不携带频道名,
 * 频道是由 joinToken 反查 hub_invites/relay 邀请表得到的。因此这里的实现不使用调用方传入的
 * `channel`,而是始终以 token 反查到的频道为准(输出里的 channel 字段是权威值)。
 */

const PULL_SCAN_LIMIT = 2000

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function toMemberOut(m: HubMemberRow): { alias: string; nodeId: string; card?: AgentCard | undefined } {
  return { alias: m.alias, nodeId: m.nodeId, card: m.card }
}

function toMessage(row: HubMessageRow): Message {
  // deliveredAt 留空:hub 不追踪"某个具体收件人何时收到",这是 engine 落 inbox 时才有意义的时间点
  return { ...row.envelope, seq: row.seq, status: row.status, deliveredAt: undefined, deliveredTo: undefined }
}

export async function openLocalHome(hubPath: string): Promise<TransportBinding> {
  const hub = openHubDb(hubPath)
  const home = `local:${hubPath}`

  return {
    kind: 'local',
    home,

    async createChannel(input) {
      return hub.withTx(() => {
        if (hub.channels.get(input.name)) {
          throw new AgentCommError('CHANNEL_EXISTS', `channel already exists: ${input.name}`)
        }
        const createdAt = nowIso()
        hub.channels.insert({
          name: input.name,
          displayName: input.displayName,
          mode: input.mode ?? 'auto',
          description: input.description,
          createdAt,
        })
        hub.members.insert({
          channel: input.name,
          alias: input.member.alias,
          nodeId: input.member.nodeId,
          publicKey: input.member.publicKey,
          scope: undefined,
          card: input.member.card,
          joinedAt: createdAt,
        })
      })
    },

    async join(input) {
      return hub.withTx(() => {
        const tokenHash = sha256Hex(input.joinToken)
        const invite = hub.invites.getByHash(tokenHash)
        if (!invite) throw new AgentCommError('INVITE_INVALID', 'unknown or invalid invite token')
        const channel = invite.channel
        const chRow = hub.channels.get(channel)
        if (!chRow) throw new AgentCommError('CHANNEL_NOT_FOUND', channel)

        // 幂等(D5/DESIGN F3):同一 node 重复兑换同频道 → 返回现状,不报错、不重复计数邀请
        const existingByNode = hub.members.getByNode(channel, input.member.nodeId)
        if (existingByNode) {
          hub.members.updateCardAndKey(
            channel,
            existingByNode.alias,
            input.member.publicKey ?? existingByNode.publicKey,
            input.member.card ?? existingByNode.card,
          )
          const members = hub.members.list(channel)
          return { channel, mode: chRow.mode, members: members.map(toMemberOut), scope: existingByNode.scope }
        }

        if (invite.expiresAt !== undefined && Date.parse(invite.expiresAt) < Date.now()) {
          throw new AgentCommError('INVITE_EXPIRED', 'invite link has expired')
        }
        if (invite.maxUses !== undefined && invite.uses >= invite.maxUses) {
          throw new AgentCommError('INVITE_EXHAUSTED', 'invite link has reached its use limit')
        }
        if (hub.members.get(channel, input.member.alias)) {
          throw new AgentCommError('ALIAS_TAKEN', `alias already in use in channel: ${input.member.alias}`)
        }

        const joinedAt = nowIso()
        hub.members.insert({
          channel,
          alias: input.member.alias,
          nodeId: input.member.nodeId,
          publicKey: input.member.publicKey,
          scope: invite.scope,
          card: input.member.card,
          joinedAt,
        })
        hub.invites.incrementUses(tokenHash)
        hub.audit.append({
          ts: joinedAt,
          event: 'connected',
          channel,
          fromAlias: input.member.alias,
          actor: `agent:${input.member.alias}`,
        })
        const members = hub.members.list(channel)
        return { channel, mode: chRow.mode, members: members.map(toMemberOut), scope: invite.scope }
      })
    },

    async leave(input) {
      return hub.withTx(() => {
        hub.members.delete(input.channel, input.alias)
      })
    },

    async mintInvite(input) {
      return hub.withTx(() => {
        if (!hub.channels.get(input.channel)) {
          throw new AgentCommError('CHANNEL_NOT_FOUND', input.channel)
        }
        const joinToken = newJoinToken()
        const expiresAt =
          input.ttlMs !== undefined ? new Date(Date.now() + input.ttlMs).toISOString() : undefined
        hub.invites.insert({
          tokenHash: sha256Hex(joinToken),
          channel: input.channel,
          scope: input.scope,
          expiresAt,
          maxUses: input.maxUses ?? 1,
          createdByNode: input.byNode,
          createdAt: nowIso(),
        })
        return { joinToken, expiresAt }
      })
    },

    async members(channel) {
      return hub.members.list(channel).map(toMemberOut)
    },

    async updateCard(input) {
      return hub.withTx(() => {
        const m = hub.members.get(input.channel, input.alias)
        if (!m) throw new AgentCommError('NOT_MEMBER', `not a member: ${input.alias}`)
        hub.members.updateCardAndKey(input.channel, input.alias, m.publicKey, input.card)
      })
    },

    async append(channel, envelopes) {
      return hub.withTx(() => {
        const chRow = hub.channels.get(channel)
        if (!chRow) throw new AgentCommError('CHANNEL_NOT_FOUND', channel)
        const results: {
          messageId: string
          seq: number
          status: 'pending' | 'held' | 'delivered'
          duplicate?: boolean
        }[] = []
        for (const env of envelopes) {
          const existing = hub.messages.getByMessageId(channel, env.messageId)
          if (existing) {
            results.push({
              messageId: env.messageId,
              seq: existing.seq,
              status: existing.status as 'pending' | 'held' | 'delivered',
              duplicate: true,
            })
            continue
          }
          if (chRow.mode === 'paused') {
            throw new AgentCommError('RATE_LIMITED', `channel is paused: ${channel}`)
          }
          const seq = hub.messages.nextSeq(channel)
          const status: MsgStatus = chRow.mode === 'intercept' ? 'held' : 'delivered'
          const ts = nowIso()
          hub.messages.insert({ channel, seq, messageId: env.messageId, envelope: env, status, ts })
          if (status === 'held') {
            hub.audit.append({
              ts,
              event: 'held',
              channel,
              messageId: env.messageId,
              fromAlias: env.from,
              toTarget: env.to,
              actor: `agent:${env.from}`,
              detail: 'intercept mode',
            })
          }
          results.push({ messageId: env.messageId, seq, status, duplicate: false })
        }
        return results
      })
    },

    async pullAfter(channel, after, opts) {
      const limit = opts?.limit ?? 200
      const raw = hub.messages.listFrom(channel, after, PULL_SCAN_LIMIT)
      const messages: Message[] = []
      let head = after
      for (const row of raw) {
        // held 是唯一非终态:游标绝不能越过它,否则放行后永远拉不到(见文件头注释)
        if (row.status === 'held') break
        head = row.seq
        if (row.status !== 'dropped') {
          messages.push(toMessage(row))
        }
        if (messages.length >= limit) break
      }
      return { messages, head }
    },

    async ackCursor(channel, nodeId, seq) {
      hub.cursors.upsert(channel, nodeId, seq, nowIso())
    },

    async listHeld(channel) {
      return hub.messages.listHeld(channel).map(toMessage)
    },

    async resolveHeld(input) {
      return hub.withTx(() => {
        const row = hub.messages.getByMessageId(input.channel, input.messageId)
        if (!row) throw new AgentCommError('MESSAGE_NOT_FOUND', input.messageId)
        if (row.status !== 'held')
          throw new AgentCommError('NOT_HELD', `message not held: ${input.messageId}`)

        if (input.resolution === 'drop') {
          hub.messages.replace({ ...row, status: 'dropped', decidedBy: input.actor })
          hub.audit.append({
            ts: nowIso(),
            event: 'dropped',
            channel: input.channel,
            messageId: input.messageId,
            fromAlias: row.envelope.from,
            toTarget: row.envelope.to,
            actor: input.actor,
          })
          return
        }

        const edited = Object.hasOwn(input, 'editedPayload') || Object.hasOwn(input, 'editedContentType')
        const envelope: MessageEnvelope = edited
          ? {
              ...row.envelope,
              ...(Object.hasOwn(input, 'editedPayload') ? { payload: input.editedPayload } : {}),
              ...(Object.hasOwn(input, 'editedContentType') ? { contentType: input.editedContentType } : {}),
            }
          : row.envelope
        hub.messages.replace({ ...row, status: 'delivered', envelope, decidedBy: input.actor })
        hub.audit.append({
          ts: nowIso(),
          event: edited ? 'edited' : 'delivered',
          channel: input.channel,
          messageId: input.messageId,
          fromAlias: envelope.from,
          toTarget: envelope.to,
          actor: input.actor,
        })
      })
    },

    async setMode(channel, mode) {
      return hub.withTx(() => {
        if (!hub.channels.get(channel)) throw new AgentCommError('CHANNEL_NOT_FOUND', channel)
        hub.channels.setMode(channel, mode)
      })
    },

    async close() {
      hub.close()
    },
  }
}
