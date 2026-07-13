import { describe, expect, it } from 'vitest'
import { freshApp, makeEnvelope, makeIdentity, signedRequest, sleep } from './helpers.js'

/** GET /ch/:channel/messages?waitMs=...:没货且 waitMs>0 时轮询等待,而不是立刻返回空 */
describe('relay: long-poll', () => {
  it('等待期间到货的新消息会被这次 GET 拿到,而不用等下一次轮询', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    const createPath = '/ch/eng/create'
    await app.request(
      createPath,
      signedRequest(lead, 'POST', createPath, {
        alias: 'lead',
        node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url },
      }),
    )

    const pullPath = '/ch/eng/messages?after=0&waitMs=2000'
    const pullPromise = app.request(pullPath, signedRequest(lead, 'GET', pullPath))

    // 200ms 后才发消息,确保这次 GET 真的在轮询等待,而不是第一次查询就已经有货
    await sleep(200)
    const messagesPath = '/ch/eng/messages'
    const env = makeEnvelope({ from: 'lead', to: '*', channel: 'eng', payload: { late: true } })
    const sendRes = await app.request(
      messagesPath,
      signedRequest(lead, 'POST', messagesPath, { messages: [env] }),
    )
    expect(sendRes.status).toBe(200)

    const pullRes = await pullPromise
    expect(pullRes.status).toBe(200)
    const body = (await pullRes.json()) as { messages: { messageId: string }[]; head: number }
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.messageId).toBe(env.messageId)
  }, 10_000)

  it('一直没有新消息 -> 超时后返回空数组(不是挂住不回)', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    const createPath = '/ch/eng/create'
    await app.request(
      createPath,
      signedRequest(lead, 'POST', createPath, {
        alias: 'lead',
        node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url },
      }),
    )

    const start = Date.now()
    const pullPath = '/ch/eng/messages?after=0&waitMs=300'
    const pullRes = await app.request(pullPath, signedRequest(lead, 'GET', pullPath))
    const elapsed = Date.now() - start
    expect(pullRes.status).toBe(200)
    const body = (await pullRes.json()) as { messages: unknown[]; head: number }
    expect(body.messages).toHaveLength(0)
    expect(body.head).toBe(0)
    expect(elapsed).toBeGreaterThanOrEqual(250) // 大致等够了 waitMs,留一点抖动余地
  }, 10_000)
})
