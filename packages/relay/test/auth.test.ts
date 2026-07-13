import { WIRE_HEADERS } from '@agent-comm/protocol'
import { describe, expect, it } from 'vitest'
import { freshApp, makeIdentity, signedRequest } from './helpers.js'

/** 鉴权中间件:签名错误 / 时钟偏移 / 缺头 / 未知节点 → 全部 401 AUTH_FAILED */
describe('relay: auth middleware', () => {
  it('GET /healthz 不要求鉴权', async () => {
    const app = freshApp()
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('缺 WIRE_HEADERS -> 401 AUTH_FAILED', async () => {
    const app = freshApp()
    const res = await app.request('/ch/eng/members', { method: 'GET' })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('AUTH_FAILED')
  })

  it('已注册节点的签名错误 -> 401 AUTH_FAILED', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    const createPath = '/ch/eng/create'
    const createBody = { alias: 'lead', node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url } }
    const okRes = await app.request(createPath, signedRequest(lead, 'POST', createPath, createBody))
    expect(okRes.status).toBe(200)

    const membersPath = '/ch/eng/members'
    const badReq = signedRequest(lead, 'GET', membersPath, undefined, {
      signatureOverride: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })
    const res = await app.request(membersPath, badReq)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_FAILED')
  })

  it('未知节点(从未 join/create 过任何频道)在非 bootstrap 端点上 -> 401 AUTH_FAILED', async () => {
    const app = freshApp()
    const ghost = makeIdentity('ghost')
    const membersPath = '/ch/eng/members'
    const res = await app.request(membersPath, signedRequest(ghost, 'GET', membersPath))
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_FAILED')
  })

  it('时钟偏移超过 300s -> 401 AUTH_FAILED', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    const createPath = '/ch/eng/create'
    const createBody = { alias: 'lead', node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url } }
    await app.request(createPath, signedRequest(lead, 'POST', createPath, createBody))

    const membersPath = '/ch/eng/members'
    const skewed = signedRequest(lead, 'GET', membersPath, undefined, {
      tsMs: Date.now() - 10 * 60 * 1000, // 10 分钟前,超出 ±300s 容忍
    })
    const res = await app.request(membersPath, skewed)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_FAILED')
  })

  it('bootstrap 端点(POST /ch/:channel/create)header 与 body.node.nodeId 不一致 -> 401', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    const impostor = makeIdentity('impostor')
    const createPath = '/ch/eng/create'
    const createBody = { alias: 'lead', node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url } }
    // 用 impostor 的签名(header node = impostor),但 body 里的 node.nodeId 填 lead 的
    const req = signedRequest(impostor, 'POST', createPath, createBody, { nodeIdOverride: impostor.nodeId })
    const res = await app.request(createPath, req)
    expect(res.status).toBe(401)
  })

  it('时间戳非法(非数字) -> 401 AUTH_FAILED', async () => {
    const app = freshApp()
    const res = await app.request('/ch/eng/members', {
      method: 'GET',
      headers: {
        [WIRE_HEADERS.node]: 'n-whatever',
        [WIRE_HEADERS.ts]: 'not-a-number',
        [WIRE_HEADERS.signature]: 'AAAA',
      },
    })
    expect(res.status).toBe(401)
  })
})
