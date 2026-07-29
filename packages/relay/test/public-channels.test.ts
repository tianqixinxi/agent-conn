import { describe, expect, it } from 'vitest'
import { createChannelBootstrap, listPublicChannels, openDb, PRESENCE_LEASE_MS } from '../src/store.js'
import { freshApp, makeEnvelope, makeIdentity, signedRequest } from './helpers.js'

describe('relay public channels', () => {
  it('keeps the human alias non-unique while routing public pages by channelId', () => {
    const db = openDb(':memory:')
    createChannelBootstrap(db, {
      channel: 'daily',
      name: 'daily',
      alias: 'alice',
      nodeId: 'n-daily-1',
      publicKey: 'pk-1',
      visibility: 'public',
    })
    createChannelBootstrap(db, {
      channel: 'c-daily-2',
      name: 'daily',
      alias: 'bob',
      nodeId: 'n-daily-2',
      publicKey: 'pk-2',
      visibility: 'public',
    })

    expect(
      listPublicChannels(db)
        .map((channel) => [channel.name, channel.channelId])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual([
      ['daily', 'c-daily-2'],
      ['daily', 'daily'],
    ])
  })

  it('serves installation guidance and only exposes plaintext messages from public channels', async () => {
    const app = freshApp()
    const lead = makeIdentity('public-lead')
    const viewer = makeIdentity('public-viewer')

    const home = await app.request('/')
    expect(home.status).toBe(200)
    const homeHtml = await home.text()
    expect(homeHtml).toContain('curl -fsSL http://localhost/install.sh | bash')
    expect(homeHtml).toContain("shellQuote(origin + '/install.sh')")
    expect(homeHtml).toContain("' | bash -s -- '")
    expect(homeHtml).toContain('id="site-language-select"')
    for (const locale of ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru']) {
      expect(homeHtml).toContain(`value="${locale}"`)
    }
    expect(homeHtml).toContain('window.navigator.languages')
    expect(homeHtml).toContain('window.navigator.language')
    expect(homeHtml).toContain("var storageKey = 'agentcomm.site.locale'")
    expect(homeHtml).toContain('window.localStorage.setItem(storageKey, preference)')
    expect(homeHtml).toContain('window.localStorage.removeItem(storageKey)')
    expect(homeHtml).toContain('data-i18n="p0HeroCopy"')
    expect(homeHtml).toContain('data-agentcomm-action="create"')
    expect(homeHtml).toContain('data-agentcomm-action="install"')
    expect(homeHtml).toContain("if (action === 'install')")
    expect(homeHtml).toContain("' + shellQuote(origin + '/install.sh') + ' | bash'")
    expect(homeHtml).toContain('AgentComm 0.8.0')
    expect(homeHtml).toContain('One install.')
    expect(homeHtml).toContain('Any agent.')
    expect(homeHtml).toContain('Three steps from zero to collaboration.')
    expect(homeHtml.match(/class="step-card"/g)).toHaveLength(3)
    expect(homeHtml).toContain('data-value-online="0"')
    expect(homeHtml).toContain('https://github.com/tianqixinxi/agent-conn/blob/main/ARCHITECTURE.md')
    expect(homeHtml).toContain('Native first. Explicit fallback.')
    expect(homeHtml).toContain('Claude Code native channel')
    expect(homeHtml).toContain('Claude print-mode')
    expect(homeHtml).toContain('Codex app-server')
    expect(homeHtml).toContain('Codex exec')
    expect(homeHtml).toContain('Generic process')
    expect(homeHtml).toContain('without pretending every desktop runtime has native push')
    expect(homeHtml).toContain('trustedAutoResume')
    expect(homeHtml).toContain('agentcomm runtime add | list | remove')
    expect(homeHtml).toContain('agentcomm daemon install | status | stop | uninstall')
    expect(homeHtml).toContain('Ship a collaboration protocol, not another transport.')
    expect(homeHtml).toContain('/api/public/applications')
    expect(homeHtml).toContain('request-response · 1.0.0')
    expect(homeHtml).toContain('manager-workers · 1.0.0')
    expect(homeHtml).toContain('agentcomm app search manager-workers')
    expect(homeHtml).toContain('agentcomm app inspect &lt;uri&gt;')
    expect(homeHtml).toContain('agentcomm app install &lt;uri&gt;')
    expect(homeHtml).toContain('agentcomm app update &lt;uri&gt;')
    expect(homeHtml).toContain('agentcomm app enable &lt;uri&gt;')
    expect(homeHtml).toContain('agentcomm app disable &lt;uri&gt;')
    expect(homeHtml).toContain('agentcomm app remove &lt;uri&gt;')
    expect(homeHtml).toContain('agentcomm app pending')
    expect(homeHtml).toContain('transport</span>')
    expect(homeHtml).toContain('application</span>')
    expect(homeHtml).toContain('harness</span>')
    expect(homeHtml).toContain('model</span>')
    expect(homeHtml).toContain('system</span>')
    expect(homeHtml).toContain('agentcomm benchmark validate suite.json')
    expect(homeHtml).toContain('agentcomm benchmark run suite.json')
    expect(homeHtml).toContain('agentcomm benchmark compare report.json')
    expect(homeHtml).toContain('Remote messages never install code')
    expect(homeHtml).toContain('Joining a channel does not approve an application')
    expect(homeHtml).not.toContain('official marketplace')
    expect(homeHtml).not.toContain('all desktop runtimes have native push')
    expect(homeHtml).not.toContain('data-i18n="layerCommunityTitle"')
    expect(homeHtml).not.toContain('data-i18n="referenceCaveat"')
    for (const packageName of [
      '@agent-comm/core',
      '@agent-comm/delivery',
      '@agent-comm/application-spec',
      '@agent-comm/client-sdk',
      '@agent-comm/a2a-binding',
      '@agent-comm/harness-claude-code',
      '@agent-comm/gateway-a2a',
      '@agent-comm/relay',
    ]) {
      expect(homeHtml).not.toContain(packageName)
    }
    expect(homeHtml).toContain('data-title-key="p0LandingTitle"')
    expect(homeHtml.split('"p0LandingTitle":')).toHaveLength(10)
    for (const key of [
      'p0HeroCopy',
      'p0HeroInstall',
      'p0ColdStartTitle',
      'p0StepRuntimeCopy',
      'p0RuntimeTitle',
      'p0RuntimeCaveat',
      'p0DeveloperTitle',
      'p0DeveloperRegistryCopy',
      'p0RegistryTitle',
      'p0BenchmarkCopy',
      'p0SecurityRemoteCopy',
      'p0SecuritySeparateCopy',
      'p0SecurityResumeCopy',
      'p0FoundationTitle',
    ]) {
      expect(homeHtml).toContain(`data-i18n="${key}"`)
      expect(homeHtml.split(`"${key}":`)).toHaveLength(10)
    }

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
    const taskRequest = makeEnvelope({
      from: 'alice',
      to: 'bob',
      channel: 'open-lab',
      contentType: 'application/a2a+json',
      payload: {
        protocolVersion: '1.0',
        kind: 'message',
        value: {
          role: 'ROLE_USER',
          parts: [{ data: { intent: 'Review the public channel timeline' }, mediaType: 'application/json' }],
          metadata: {
            'https://agentcomm.dev/extensions/private-channel/v1': {
              taskId: 'task-m-public-channel-review',
            },
          },
        },
      },
    })
    const taskCompleted = makeEnvelope({
      from: 'bob',
      to: 'alice',
      channel: 'open-lab',
      contentType: 'application/a2a+json',
      payload: {
        protocolVersion: '1.0',
        kind: 'status-update',
        value: {
          taskId: 'task-m-public-channel-review',
          status: {
            state: 'TASK_STATE_COMPLETED',
            timestamp: '2026-07-27T12:00:00.000Z',
          },
        },
      },
    })
    expect(
      (
        await app.request(
          messagePath,
          signedRequest(lead, 'POST', messagePath, {
            messages: [envelope, taskRequest, taskCompleted],
          }),
        )
      ).status,
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

    const discovery = await app.request('/api/public/channels/open-lab')
    expect(await discovery.json()).toMatchObject({
      channel: { name: 'open-lab' },
      agents: [{ alias: 'alice' }],
      join: { operation: 'connect', link: 'http://localhost/public/open-lab' },
      messages: 'http://localhost/api/public/channels/open-lab/messages',
    })

    const proxiedDiscovery = await app.request('/api/public/channels/open-lab', {
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(await proxiedDiscovery.json()).toMatchObject({
      join: { link: 'https://localhost/public/open-lab' },
      messages: 'https://localhost/api/public/channels/open-lab/messages',
    })

    const page = await app.request('/public/open-lab')
    const pageHtml = await page.text()
    expect(page.status).toBe(200)
    expect(pageHtml).toContain('Open Lab')
    expect(pageHtml).toContain('1 active now · 1 total')
    expect(pageHtml).not.toContain('claude-cli://open?q=')
    expect(pageHtml).toContain('data-terminal-command')
    expect(pageHtml).toContain('copiedLaunchCommand')
    expect(pageHtml).toContain('自动更新 · 每 3 秒刷新一次')
    expect(pageHtml).toContain('For agent runtimes')
    expect(pageHtml).toContain('data-i18n="timelineTitle"')
    expect(pageHtml).toContain('data-agentcomm-action="join"')
    expect(pageHtml).toContain('data-public-url="http://localhost/public/open-lab"')
    expect(pageHtml).toContain('class="message-avatar"')
    expect(pageHtml).toContain('data-message-kind="request"')
    expect(pageHtml).toContain('data-message-kind="status"')
    expect(pageHtml).toContain('data-i18n="messageTypeRequest"')
    expect(pageHtml).toContain('data-i18n="messageTypeStatus"')
    expect(pageHtml).toContain('data-i18n="taskCompleted"')
    expect(pageHtml).toContain('Review the public channel timeline')
    expect(pageHtml).toContain('<details class="protocol-details">')
    expect(pageHtml).not.toContain('<details class="protocol-details" open')
    expect(pageHtml).toContain('data-message-time=')
    expect(pageHtml).toContain('function payloadView(payload)')
    expect(pageHtml).not.toContain('})()\n(() =>')
    expect(pageHtml).toContain('&lt;script&gt;alert(&quot;not html&quot;)&lt;/script&gt;')
    expect(pageHtml).not.toContain('<script>alert("not html")</script>')
    for (const key of [
      'messageTo',
      'messageEveryone',
      'messageTypeRequest',
      'messageTypeStatus',
      'taskCompleted',
      'messageNoPreview',
    ]) {
      expect(homeHtml.split(`"${key}":`)).toHaveLength(10)
    }

    expect((await app.request('/public/secret-lab')).status).toBe(404)
    expect((await app.request('/api/public/channels/secret-lab/messages')).status).toBe(404)

    const publicJoinPath = '/ch/open-lab/public-join'
    const publicJoinBody = {
      alias: 'bob',
      node: { nodeId: viewer.nodeId, publicKey: viewer.publicKeyB64url },
    }
    const publicJoin = await app.request(
      publicJoinPath,
      signedRequest(viewer, 'POST', publicJoinPath, publicJoinBody),
    )
    expect(publicJoin.status).toBe(200)
    expect((await publicJoin.json()) as object).toMatchObject({
      channel: 'open-lab',
      visibility: 'public',
      myAlias: 'bob',
    })
    // The page URL is stable; reconnecting the same node is idempotent and does not duplicate membership.
    const repeatJoin = await app.request(
      publicJoinPath,
      signedRequest(viewer, 'POST', publicJoinPath, publicJoinBody),
    )
    expect(repeatJoin.status).toBe(200)

    const privateJoinPath = '/ch/secret-lab/public-join'
    const privateJoin = await app.request(
      privateJoinPath,
      signedRequest(viewer, 'POST', privateJoinPath, {
        alias: 'bob',
        node: { nodeId: viewer.nodeId, publicKey: viewer.publicKeyB64url },
      }),
    )
    expect(privateJoin.status).toBe(404)
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
