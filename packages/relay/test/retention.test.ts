import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { openDb } from '../src/store.js'
import { makeEnvelope, makeIdentity, signedRequest } from './helpers.js'

/**
 * retention 不在工单要求的必测清单里,但既然工单要求汇报"retention 策略实际实现",这里
 * 直接验证一下:硬 30 天 TTL、以及"全员 ack 且 >7 天"的软 TTL。用真实文件(不是 :memory:)
 * 是因为要开第二条独立连接直接改 ts 列——绕开 wire 协议,纯 SQL 操纵时间,不然没法在测试
 * 里等 7/30 天。
 */
describe('relay: retention 清理', () => {
  it('硬 TTL:超过 30 天的消息,不论是否 ack,下一次写后都会被清除', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-comm-relay-test-'))
    const dbPath = join(dir, 'relay.db')
    try {
      const app = createApp({ dbPath })
      const lead = makeIdentity('lead-hard')

      const createPath = '/ch/eng/create'
      await app.request(
        createPath,
        signedRequest(lead, 'POST', createPath, {
          alias: 'lead',
          node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url },
        }),
      )

      const messagesPath = '/ch/eng/messages'
      const oldEnv = makeEnvelope({ from: 'lead', to: '*', channel: 'eng', payload: { old: true } })
      const sendRes = await app.request(
        messagesPath,
        signedRequest(lead, 'POST', messagesPath, { messages: [oldEnv] }),
      )
      expect(sendRes.status).toBe(200)

      // 独立连接直接改这条消息的 ts,伪造成 31 天前(没 ack、也无所谓——硬 TTL 不看 ack)
      const direct = openDb(dbPath)
      const cutoff = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
      direct.raw.prepare('UPDATE messages SET ts = ? WHERE message_id = ?').run(cutoff, oldEnv.messageId)

      // 再发一条新消息,触发"每次写后惰性清理"
      const freshEnv = makeEnvelope({ from: 'lead', to: '*', channel: 'eng', payload: { fresh: true } })
      const send2Res = await app.request(
        messagesPath,
        signedRequest(lead, 'POST', messagesPath, { messages: [freshEnv] }),
      )
      expect(send2Res.status).toBe(200)

      const remaining = direct.raw
        .prepare('SELECT message_id FROM messages WHERE channel = ?')
        .all('eng') as {
        message_id: string
      }[]
      const ids = remaining.map((r) => r.message_id)
      expect(ids).not.toContain(oldEnv.messageId)
      expect(ids).toContain(freshEnv.messageId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('软 TTL:全员 ack 且 >7 天才清除;只要还有成员没 ack 就保留', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-comm-relay-test-'))
    const dbPath = join(dir, 'relay.db')
    try {
      const app = createApp({ dbPath })
      const lead = makeIdentity('lead-soft')
      const alice = makeIdentity('alice-soft')

      const createPath = '/ch/soft/create'
      await app.request(
        createPath,
        signedRequest(lead, 'POST', createPath, {
          alias: 'lead',
          node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url },
        }),
      )
      const invitesPath = '/ch/soft/invites'
      const invitesRes = await app.request(
        invitesPath,
        signedRequest(lead, 'POST', invitesPath, { maxUses: 1 }),
      )
      const invite = (await invitesRes.json()) as { joinToken: string }
      const joinPath = '/join'
      await app.request(
        joinPath,
        signedRequest(alice, 'POST', joinPath, {
          joinToken: invite.joinToken,
          alias: 'alice',
          node: { nodeId: alice.nodeId, publicKey: alice.publicKeyB64url },
        }),
      )

      const messagesPath = '/ch/soft/messages'
      const env = makeEnvelope({ from: 'lead', to: '*', channel: 'soft', payload: { text: 'old-ish' } })
      await app.request(messagesPath, signedRequest(lead, 'POST', messagesPath, { messages: [env] }))

      const direct = openDb(dbPath)
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      direct.raw.prepare('UPDATE messages SET ts = ? WHERE message_id = ?').run(eightDaysAgo, env.messageId)

      // 只有 lead ack -> 不能判定"全员 acked"(alice 从没 ack 过),消息应该还在
      const ackPath = '/ch/soft/ack'
      await app.request(ackPath, signedRequest(lead, 'POST', ackPath, { seq: 1 }))
      let rows = direct.raw.prepare('SELECT message_id FROM messages WHERE channel = ?').all('soft') as {
        message_id: string
      }[]
      expect(rows.map((r) => r.message_id)).toContain(env.messageId)

      // alice 也 ack -> 全员 acked + 已经 >7 天 -> 这次该被清掉了
      await app.request(ackPath, signedRequest(alice, 'POST', ackPath, { seq: 1 }))
      rows = direct.raw.prepare('SELECT message_id FROM messages WHERE channel = ?').all('soft') as {
        message_id: string
      }[]
      expect(rows.map((r) => r.message_id)).not.toContain(env.messageId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
