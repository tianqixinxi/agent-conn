import { describe, expect, it } from 'vitest'
import { createChannelBootstrap, listPublicChannels, openDb, PRESENCE_LEASE_MS } from '../src/store.js'
import { freshApp, makeEnvelope, makeIdentity, signedRequest } from './helpers.js'

describe('relay public channels', () => {
  it('serves installation guidance and only exposes plaintext messages from public channels', async () => {
    const app = freshApp()
    const lead = makeIdentity('public-lead')

    const home = await app.request('/')
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('claude plugin install agent-comm@agent-comm')

    const publicCreatePath = '/ch/open-lab/create'
    const publicCreateBody = {
      alias: 'alice',
      visibility: 'public',
      displayName: 'Open Lab',
      description: 'Human-readable agent work',
      node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url },
    }
    const publicCreate = await app.request(
      publicCreatePath,
      signedRequest(lead, 'POST', publicCreatePath, publicCreateBody),
    )
    expect(publicCreate.status).toBe(200)
    expect((await publicCreate.json()) as object).toMatchObject({ visibility: 'public' })

    const privateCreatePath = '/ch/secret-lab/create'
    const privateCreateBody = {
      alias: 'alice',
      node: { nodeId: lead.nodeId, publicKey: lead.publicKeyB64url },
    }
    expect(
      (
        await app.request(
          privateCreatePath,
          signedRequest(lead, 'POST', privateCreatePath, privateCreateBody),
        )
      ).status,
    ).toBe(200)

    const messagePath = '/ch/open-lab/messages'
    const envelope = makeEnvelope({
      from: 'alice',
      to: '*',
      channel: 'open-lab',
      contentType: 'text/plain',
      payload: '<script>alert("not html")</script>',
    })
    expect(
      (await app.request(messagePath, signedRequest(lead, 'POST', messagePath, { messages: [envelope] })))
        .status,
    ).toBe(200)

    const directory = await app.request('/api/public/channels')
    const directoryBody = (await directory.json()) as {
      channels: { name: string; onlineMembers: number }[]
    }
    expect(directoryBody.channels.map((channel) => channel.name)).toEqual(['open-lab'])
    expect(directoryBody.channels[0]?.onlineMembers).toBe(1)

    const feed = await app.request('/api/public/channels/open-lab/messages')
    const feedBody = (await feed.json()) as { messages: { payload: unknown }[] }
    expect(feedBody.messages[0]?.payload).toBe('<script>alert("not html")</script>')

    const page = await app.request('/public/open-lab')
    const pageHtml = await page.text()
    expect(page.status).toBe(200)
    expect(pageHtml).toContain('Open Lab')
    expect(pageHtml).toContain('1/1 agents online')
    expect(pageHtml).toContain('&lt;script&gt;alert(&quot;not html&quot;)&lt;/script&gt;')
    expect(pageHtml).not.toContain('<script>alert("not html")</script>')

    expect((await app.request('/public/secret-lab')).status).toBe(404)
    expect((await app.request('/api/public/channels/secret-lab/messages')).status).toBe(404)
  })

  it('treats presence as an expiring soft lease without deleting membership', () => {
    const db = openDb(':memory:')
    createChannelBootstrap(db, {
      channel: 'presence-lab',
      alias: 'alice',
      nodeId: 'n-presence-alice',
      publicKey: 'test-public-key',
      visibility: 'public',
    })
    expect(listPublicChannels(db)[0]).toMatchObject({ members: 1, onlineMembers: 1 })

    const expired = new Date(Date.now() - PRESENCE_LEASE_MS - 1_000).toISOString()
    db.raw.prepare('UPDATE members SET last_seen_at = ?').run(expired)
    expect(listPublicChannels(db)[0]).toMatchObject({ members: 1, onlineMembers: 0 })
  })
})
