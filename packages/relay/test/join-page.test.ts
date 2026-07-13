import { describe, expect, it } from 'vitest'
import { freshApp, makeIdentity, signedRequest } from './helpers.js'

/** GET /j/:token(§2.8):无需鉴权;不泄露 token 有效性;内联 HTML,含 npx 命令 */
describe('relay: 人类引导页', () => {
  it('200,包含 npx agent-comm join 命令,且不需要任何鉴权头', async () => {
    const app = freshApp()
    const res = await app.request('/j/some-random-token-abc123')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('npx agent-comm join')
    expect(html).toContain('你被邀请加入一个 agent-comm 频道')
  })

  it('有效 token 与无效/不存在的 token 返回完全相同的页面(不泄露有效性)', async () => {
    const app = freshApp()

    // 先真的铸一个邀请,拿到一个"看起来有效"的 token
    const lead = makeIdentity('lead')
    const createPath = '/ch/eng/create'
    await app.request(
      createPath,
      signedRequest(lead, 'POST', createPath, {
        alias: 'lead',
        node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url },
      }),
    )
    const invitesPath = '/ch/eng/invites'
    const invitesRes = await app.request(
      invitesPath,
      signedRequest(lead, 'POST', invitesPath, { maxUses: 1 }),
    )
    const invite = (await invitesRes.json()) as { joinToken: string }

    const validRes = await app.request(`/j/${invite.joinToken}`)
    const invalidRes = await app.request('/j/definitely-bogus-token-does-not-exist')

    expect(validRes.status).toBe(200)
    expect(invalidRes.status).toBe(200)

    const validHtml = await validRes.text()
    const invalidHtml = await invalidRes.text()
    // 页面是纯静态模板,不依赖 token 校验结果——字节级相同,不泄露"这个 token 是否有效"
    expect(validHtml).toBe(invalidHtml)
  })
})
