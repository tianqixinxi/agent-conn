import { ICEBREAK_DEFAULTS } from '@agent-comm/protocol'
import { describe, expect, it } from 'vitest'
import { freshApp, makeEnvelope, makeIdentity, signedRequest } from './helpers.js'

async function bootstrapChannel(
  app: ReturnType<typeof freshApp>,
  channel: string,
  lead: ReturnType<typeof makeIdentity>,
  mode?: 'auto' | 'intercept' | 'paused',
) {
  const path = `/ch/${channel}/create`
  const body = {
    alias: 'lead',
    node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url },
    ...(mode ? { mode } : {}),
  }
  const res = await app.request(path, signedRequest(lead, 'POST', path, body))
  expect(res.status).toBe(200)
}

async function mintAndJoin(
  app: ReturnType<typeof freshApp>,
  channel: string,
  lead: ReturnType<typeof makeIdentity>,
  joiner: ReturnType<typeof makeIdentity>,
  alias: string,
) {
  const invitesPath = `/ch/${channel}/invites`
  const invitesRes = await app.request(invitesPath, signedRequest(lead, 'POST', invitesPath, { maxUses: 5 }))
  const invite = (await invitesRes.json()) as { joinToken: string }
  const joinPath = '/join'
  const joinRes = await app.request(
    joinPath,
    signedRequest(joiner, 'POST', joinPath, {
      joinToken: invite.joinToken,
      alias,
      node: { nodeId: joiner.nodeId, publicKey: joiner.publicKeyB64url },
    }),
  )
  expect(joinRes.status).toBe(200)
}

describe('relay: 破冰限流(D3.2)', () => {
  it('新成员在无人回应前累计上行超过 maxBeforeReply -> 429;对方回帖后解除', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    const alice = makeIdentity('alice')
    await bootstrapChannel(app, 'eng', lead)
    await mintAndJoin(app, 'eng', lead, alice, 'alice')

    const messagesPath = '/ch/eng/messages'
    const cap = ICEBREAK_DEFAULTS.maxBeforeReply

    // 一次性发满 cap 条,应该全部成功
    const batch = Array.from({ length: cap }, (_, i) =>
      makeEnvelope({ from: 'alice', to: 'lead', channel: 'eng', payload: { i } }),
    )
    const okRes = await app.request(
      messagesPath,
      signedRequest(alice, 'POST', messagesPath, { messages: batch }),
    )
    expect(okRes.status).toBe(200)
    const okBody = (await okRes.json()) as { accepted: unknown[] }
    expect(okBody.accepted).toHaveLength(cap)

    // 第 cap+1 条(哪怕只是新的一次单条请求)应该被限流
    const overLimit = makeEnvelope({ from: 'alice', to: 'lead', channel: 'eng', payload: { over: true } })
    const limitedRes = await app.request(
      messagesPath,
      signedRequest(alice, 'POST', messagesPath, { messages: [overLimit] }),
    )
    expect(limitedRes.status).toBe(429)
    const limitedBody = (await limitedRes.json()) as { error: { code: string; retryAfterMs?: number } }
    expect(limitedBody.error.code).toBe('RATE_LIMITED')
    expect(limitedBody.error.retryAfterMs).toBeGreaterThan(0)

    // lead(另一个成员)回帖 -> 解除 alice 的破冰限流
    const leadReply = makeEnvelope({ from: 'lead', to: 'alice', channel: 'eng', payload: { reply: true } })
    const replyRes = await app.request(
      messagesPath,
      signedRequest(lead, 'POST', messagesPath, { messages: [leadReply] }),
    )
    expect(replyRes.status).toBe(200)

    // 现在 alice 可以继续发,即便超过原来的 cap
    const afterBreakRes = await app.request(
      messagesPath,
      signedRequest(alice, 'POST', messagesPath, { messages: [overLimit] }),
    )
    expect(afterBreakRes.status).toBe(200)
  })

  it('bootstrap 创建者本人在无人加入时也受破冰限流约束', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead-solo')
    await bootstrapChannel(app, 'solo', lead)
    const messagesPath = '/ch/solo/messages'
    const cap = ICEBREAK_DEFAULTS.maxBeforeReply
    for (let i = 0; i < cap; i++) {
      const env = makeEnvelope({ from: 'lead', to: '*', channel: 'solo', payload: { i } })
      const res = await app.request(
        messagesPath,
        signedRequest(lead, 'POST', messagesPath, { messages: [env] }),
      )
      expect(res.status).toBe(200)
    }
    const overLimit = makeEnvelope({ from: 'lead', to: '*', channel: 'solo', payload: { over: true } })
    const res = await app.request(
      messagesPath,
      signedRequest(lead, 'POST', messagesPath, { messages: [overLimit] }),
    )
    expect(res.status).toBe(429)
  })
})

describe('relay: intercept 频道', () => {
  it('intercept 模式下消息被 held,不通过 GET 下发', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    const alice = makeIdentity('alice')
    await bootstrapChannel(app, 'iv', lead, 'intercept')
    await mintAndJoin(app, 'iv', lead, alice, 'alice')

    const messagesPath = '/ch/iv/messages'
    const env = makeEnvelope({ from: 'alice', to: '*', channel: 'iv', payload: { text: 'needs review' } })
    const sendRes = await app.request(
      messagesPath,
      signedRequest(alice, 'POST', messagesPath, { messages: [env] }),
    )
    expect(sendRes.status).toBe(200)
    const sendBody = (await sendRes.json()) as { accepted: { status: string; seq: number }[] }
    expect(sendBody.accepted[0]?.status).toBe('held')

    const pullPath = '/ch/iv/messages?after=0'
    const pullRes = await app.request(pullPath, signedRequest(lead, 'GET', pullPath))
    expect(pullRes.status).toBe(200)
    const pullBody = (await pullRes.json()) as { messages: unknown[]; head: number }
    // seq 已经分配(head=1),但 held 消息不下发
    expect(pullBody.head).toBe(1)
    expect(pullBody.messages).toHaveLength(0)
  })
})

describe('relay: paused 频道', () => {
  it('paused 模式下发送直接 429,不入库', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    await bootstrapChannel(app, 'pz', lead, 'paused')
    const messagesPath = '/ch/pz/messages'
    const env = makeEnvelope({ from: 'lead', to: '*', channel: 'pz', payload: { text: 'hello' } })
    const res = await app.request(
      messagesPath,
      signedRequest(lead, 'POST', messagesPath, { messages: [env] }),
    )
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
  })
})
