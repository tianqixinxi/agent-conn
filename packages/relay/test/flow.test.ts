import { describe, expect, it } from 'vitest'
import { freshApp, makeEnvelope, makeIdentity, signedRequest } from './helpers.js'

/**
 * 完整链路:bootstrap 建频道 + 铸邀请 → join → append(定向 + 广播)→ pull → ack。
 * 顺带覆盖 messageId 幂等重放、from 盖戳改写(这两点天然长在同一条链路上,不必另开文件)。
 */
describe('relay: full lifecycle', () => {
  it('bootstrap create -> invite -> join -> append -> pull -> ack', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    const alice = makeIdentity('alice')

    // 1) bootstrap 建频道(POST /ch/:channel/create,relay 自定端点)
    const createPath = '/ch/eng/create'
    const createBody = { alias: 'lead', node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url } }
    const createRes = await app.request(createPath, signedRequest(lead, 'POST', createPath, createBody))
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as {
      channel: string
      mode: string
      myAlias: string
      members: { alias: string; nodeId: string }[]
    }
    expect(created.channel).toBe('eng')
    expect(created.mode).toBe('auto')
    expect(created.myAlias).toBe('lead')
    expect(created.members).toHaveLength(1)

    // 重复 bootstrap 同一频道 -> 409 CHANNEL_EXISTS
    const dupCreateRes = await app.request(createPath, signedRequest(lead, 'POST', createPath, createBody))
    expect(dupCreateRes.status).toBe(409)
    expect(((await dupCreateRes.json()) as { error: { code: string } }).error.code).toBe('CHANNEL_EXISTS')

    // 2) 铸邀请(POST /ch/:channel/invites,调用者须是成员)
    const invitesPath = '/ch/eng/invites'
    const invitesRes = await app.request(
      invitesPath,
      signedRequest(lead, 'POST', invitesPath, { maxUses: 5 }),
    )
    expect(invitesRes.status).toBe(200)
    const invite = (await invitesRes.json()) as { joinToken: string; expiresAt?: string }
    expect(invite.joinToken.length).toBeGreaterThan(0)
    expect(invite.expiresAt).toBeUndefined()

    // 3) alice 兑换邀请入频道(POST /join,TOFU 注册公钥)
    const joinPath = '/join'
    const joinBody = {
      joinToken: invite.joinToken,
      alias: 'alice',
      node: { nodeId: alice.nodeId, publicKey: alice.publicKeyB64url },
    }
    const joinRes = await app.request(joinPath, signedRequest(alice, 'POST', joinPath, joinBody))
    expect(joinRes.status).toBe(200)
    const joined = (await joinRes.json()) as {
      channel: string
      myAlias: string
      members: { alias: string }[]
    }
    expect(joined.channel).toBe('eng')
    expect(joined.myAlias).toBe('alice')
    expect(joined.members.map((m) => m.alias).sort()).toEqual(['alice', 'lead'])

    // 同 (nodeId, alias) 重复 join 幂等返回现状,不报错、不重复计数
    const joinAgainRes = await app.request(joinPath, signedRequest(alice, 'POST', joinPath, joinBody))
    expect(joinAgainRes.status).toBe(200)
    const joinedAgain = (await joinAgainRes.json()) as { members: unknown[] }
    expect(joinedAgain.members).toHaveLength(2)

    // 4) alice 发送:一条定向给 lead,一条广播;第二条故意伪造 from,relay 应改写并照常接受
    const messagesPath = '/ch/eng/messages'
    const directed = makeEnvelope({ from: 'alice', to: 'lead', channel: 'eng', payload: { text: 'hi lead' } })
    const broadcastSpoofed = makeEnvelope({
      from: 'someone-else', // 冒充:relay 必须改写成 alice 的注册 alias
      to: '*',
      channel: 'eng',
      payload: { text: 'hello everyone' },
    })
    const sendRes = await app.request(
      messagesPath,
      signedRequest(alice, 'POST', messagesPath, { messages: [directed, broadcastSpoofed] }),
    )
    expect(sendRes.status).toBe(200)
    const sent = (await sendRes.json()) as {
      accepted: { messageId: string; seq: number; status: string; duplicate?: boolean }[]
    }
    expect(sent.accepted).toHaveLength(2)
    expect(sent.accepted[0]?.seq).toBe(1)
    expect(sent.accepted[1]?.seq).toBe(2)
    for (const a of sent.accepted) {
      expect(a.status).toBe('delivered')
      expect(a.duplicate).toBeUndefined()
    }

    // 5) lead 拉取:两条都应该到(relay 不按 to 过滤,过滤是客户端 engine 的事)
    const pullPath = '/ch/eng/messages?after=0&limit=100'
    const pullRes = await app.request(pullPath, signedRequest(lead, 'GET', pullPath))
    expect(pullRes.status).toBe(200)
    const pulled = (await pullRes.json()) as {
      head: number
      messages: { messageId: string; from: string; to: string; seq: number; status: string }[]
    }
    expect(pulled.head).toBe(2)
    expect(pulled.messages).toHaveLength(2)
    const [m1, m2] = pulled.messages
    expect(m1?.messageId).toBe(directed.messageId)
    expect(m1?.from).toBe('alice')
    expect(m1?.to).toBe('lead')
    // from 盖戳:伪造的 from 必须被改写成 alice(注册 alias),而不是 'someone-else'
    expect(m2?.messageId).toBe(broadcastSpoofed.messageId)
    expect(m2?.from).toBe('alice')
    expect(m2?.to).toBe('*')

    // 6) messageId 重放(幂等):原样再发一次同一条 directed 消息 -> duplicate:true,seq 不变
    const replayRes = await app.request(
      messagesPath,
      signedRequest(alice, 'POST', messagesPath, { messages: [directed] }),
    )
    expect(replayRes.status).toBe(200)
    const replayed = (await replayRes.json()) as {
      accepted: { messageId: string; seq: number; duplicate?: boolean }[]
    }
    expect(replayed.accepted).toHaveLength(1)
    expect(replayed.accepted[0]?.duplicate).toBe(true)
    expect(replayed.accepted[0]?.seq).toBe(1)

    // 7) lead ack 到 seq=2
    const ackPath = '/ch/eng/ack'
    const ackRes = await app.request(ackPath, signedRequest(lead, 'POST', ackPath, { seq: 2 }))
    expect(ackRes.status).toBe(200)
    expect(await ackRes.json()).toEqual({ ok: true })

    // 8) GET /ch/:channel/members 也应该看到两个成员
    const membersPath = '/ch/eng/members'
    const membersRes = await app.request(membersPath, signedRequest(lead, 'GET', membersPath))
    expect(membersRes.status).toBe(200)
    const membersBody = (await membersRes.json()) as { members: { alias: string }[] }
    expect(membersBody.members.map((m) => m.alias).sort()).toEqual(['alice', 'lead'])
  })

  it('publish_card 更新自己的卡片,GET members 能看到', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead2')
    const createPath = '/ch/support/create'
    await app.request(
      createPath,
      signedRequest(lead, 'POST', createPath, {
        alias: 'lead',
        node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url },
      }),
    )
    const cardPath = '/ch/support/card'
    const cardRes = await app.request(
      cardPath,
      signedRequest(lead, 'POST', cardPath, { card: { name: 'Lead Agent', skills: ['triage'] } }),
    )
    expect(cardRes.status).toBe(200)
    expect(await cardRes.json()).toEqual({ ok: true })

    const membersPath = '/ch/support/members'
    const membersRes = await app.request(membersPath, signedRequest(lead, 'GET', membersPath))
    const body = (await membersRes.json()) as { members: { alias: string; card?: { name: string } }[] }
    expect(body.members[0]?.card?.name).toBe('Lead Agent')
  })
})
