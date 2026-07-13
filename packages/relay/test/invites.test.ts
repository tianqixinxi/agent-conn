import { describe, expect, it } from 'vitest'
import { freshApp, makeIdentity, signedRequest, sleep } from './helpers.js'

async function bootstrapChannel(
  app: ReturnType<typeof freshApp>,
  channel: string,
  lead: ReturnType<typeof makeIdentity>,
) {
  const path = `/ch/${channel}/create`
  const body = { alias: 'lead', node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url } }
  const res = await app.request(path, signedRequest(lead, 'POST', path, body))
  expect(res.status).toBe(200)
}

describe('relay: 邀请生命周期', () => {
  it('token 不存在 -> 404 INVITE_INVALID', async () => {
    const app = freshApp()
    const alice = makeIdentity('alice')
    const joinPath = '/join'
    const res = await app.request(
      joinPath,
      signedRequest(alice, 'POST', joinPath, {
        joinToken: 'this-token-does-not-exist',
        alias: 'alice',
        node: { nodeId: alice.nodeId, publicKey: alice.publicKeyB64url },
      }),
    )
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVITE_INVALID')
  })

  it('token 过期 -> 409 INVITE_EXPIRED', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    const alice = makeIdentity('alice')
    await bootstrapChannel(app, 'eng', lead)

    const invitesPath = '/ch/eng/invites'
    const invitesRes = await app.request(invitesPath, signedRequest(lead, 'POST', invitesPath, { ttlMs: 10 }))
    expect(invitesRes.status).toBe(200)
    const invite = (await invitesRes.json()) as { joinToken: string; expiresAt?: string }
    expect(invite.expiresAt).toBeDefined()
    await sleep(50)

    const joinPath = '/join'
    const res = await app.request(
      joinPath,
      signedRequest(alice, 'POST', joinPath, {
        joinToken: invite.joinToken,
        alias: 'alice',
        node: { nodeId: alice.nodeId, publicKey: alice.publicKeyB64url },
      }),
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVITE_EXPIRED')
  })

  it('token 超过 maxUses -> 409 INVITE_EXHAUSTED', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    const alice = makeIdentity('alice')
    const bob = makeIdentity('bob')
    await bootstrapChannel(app, 'eng', lead)

    const invitesPath = '/ch/eng/invites'
    const invitesRes = await app.request(
      invitesPath,
      signedRequest(lead, 'POST', invitesPath, { maxUses: 1 }),
    )
    const invite = (await invitesRes.json()) as { joinToken: string }

    const joinPath = '/join'
    const firstJoin = await app.request(
      joinPath,
      signedRequest(alice, 'POST', joinPath, {
        joinToken: invite.joinToken,
        alias: 'alice',
        node: { nodeId: alice.nodeId, publicKey: alice.publicKeyB64url },
      }),
    )
    expect(firstJoin.status).toBe(200)

    const secondJoin = await app.request(
      joinPath,
      signedRequest(bob, 'POST', joinPath, {
        joinToken: invite.joinToken,
        alias: 'bob',
        node: { nodeId: bob.nodeId, publicKey: bob.publicKeyB64url },
      }),
    )
    expect(secondJoin.status).toBe(409)
    expect(((await secondJoin.json()) as { error: { code: string } }).error.code).toBe('INVITE_EXHAUSTED')
  })

  it('alias 冲突 -> 409 ALIAS_TAKEN', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    const alice = makeIdentity('alice')
    const bob = makeIdentity('bob')
    await bootstrapChannel(app, 'eng', lead)

    const invitesPath = '/ch/eng/invites'
    const invitesRes = await app.request(
      invitesPath,
      signedRequest(lead, 'POST', invitesPath, { maxUses: 5 }),
    )
    const invite = (await invitesRes.json()) as { joinToken: string }

    const joinPath = '/join'
    const firstJoin = await app.request(
      joinPath,
      signedRequest(alice, 'POST', joinPath, {
        joinToken: invite.joinToken,
        alias: 'dup',
        node: { nodeId: alice.nodeId, publicKey: alice.publicKeyB64url },
      }),
    )
    expect(firstJoin.status).toBe(200)

    const secondJoin = await app.request(
      joinPath,
      signedRequest(bob, 'POST', joinPath, {
        joinToken: invite.joinToken,
        alias: 'dup', // 同一个 alias,不同 nodeId
        node: { nodeId: bob.nodeId, publicKey: bob.publicKeyB64url },
      }),
    )
    expect(secondJoin.status).toBe(409)
    expect(((await secondJoin.json()) as { error: { code: string } }).error.code).toBe('ALIAS_TAKEN')
  })

  it('铸邀请要求调用者是成员;非成员 -> 403 NOT_MEMBER,频道不存在 -> 404 CHANNEL_NOT_FOUND', async () => {
    const app = freshApp()
    const lead = makeIdentity('lead')
    const outsider = makeIdentity('outsider')
    await bootstrapChannel(app, 'eng', lead)
    // outsider 必须先在别的频道露过面(relay 才认识它的公钥),否则鉴权中间件会在
    // 业务逻辑之前就以 401 AUTH_FAILED 拒绝——这里要测的是"认识你、但你不是这个频道的
    // 成员"这个 403 分支,所以先让它 bootstrap 一个不相关的频道建立身份。
    await bootstrapChannel(app, 'unrelated', outsider)

    const invitesPath = '/ch/eng/invites'
    const notMemberRes = await app.request(
      invitesPath,
      signedRequest(outsider, 'POST', invitesPath, { maxUses: 1 }),
    )
    expect(notMemberRes.status).toBe(403)
    expect(((await notMemberRes.json()) as { error: { code: string } }).error.code).toBe('NOT_MEMBER')

    const missingChannelPath = '/ch/does-not-exist/invites'
    const missingRes = await app.request(
      missingChannelPath,
      signedRequest(lead, 'POST', missingChannelPath, { maxUses: 1 }),
    )
    expect(missingRes.status).toBe(404)
    expect(((await missingRes.json()) as { error: { code: string } }).error.code).toBe('CHANNEL_NOT_FOUND')
  })
})
