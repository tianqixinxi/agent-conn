import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { renderJoinPage } from '../src/join-page.js'
import { freshApp, makeIdentity, signedRequest } from './helpers.js'

describe('relay: invitation and cold-start pages', () => {
  it('serves a multilingual terminal-first flow without a Claude deep link', async () => {
    const app = freshApp()
    const res = await app.request('/j/some-random-token-abc123')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()

    expect(html).toContain("shellQuote(base + '/install.sh')")
    expect(html).toContain("' | bash -s -- open '")
    expect(html).toContain('$HOME/.local/bin/agentcomm open')
    expect(html).toContain('id="copy-command-btn"')
    expect(html).toContain('id="copy-safe-btn"')
    expect(html).toContain('window.location.origin')
    expect(html).not.toContain('claude-cli://')
    expect(html).not.toContain('agentcomm://')
    expect(html).not.toContain('fetch(')

    expect(html).toContain('window.navigator.languages')
    expect(html).toContain('window.navigator.language')
    expect(html).toContain("toLowerCase().split('-')[0]")
    expect(html).toContain("var supportedLocales = ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru']")
    expect(html).toContain('id="language-select"')
    expect(html).toContain('<option value="zh">中文</option>')
    expect(html).toContain('<option value="en">English</option>')
    expect(html).toContain('<option value="ja">日本語</option>')
    expect(html).toContain('<option value="ko">한국어</option>')
    expect(html).toContain('<option value="es">Español</option>')
    expect(html).toContain('<option value="fr">Français</option>')
    expect(html).toContain('<option value="de">Deutsch</option>')
    expect(html).toContain('<option value="pt">Português</option>')
    expect(html).toContain('<option value="ru">Русский</option>')
    expect(html).toContain('agentcomm.invitation.locale')
    expect(html).toContain('window.localStorage.getItem(localeStorageKey)')
    expect(html).toContain('window.localStorage.setItem(localeStorageKey, localePreference)')
    expect(html).toContain('window.localStorage.removeItem(localeStorageKey)')
    expect(html).toContain("applyLocale(localePreference === 'auto' ? browserLocale : localePreference)")

    expect(html).toContain('You have been invited to an AgentComm channel')
    expect(html).toContain('你被邀请加入一个 AgentComm 频道')
    expect(html).toContain('AgentComm チャンネルに招待されました')
    expect(html).toContain('AgentComm 채널에 초대되었습니다')
    expect(html).toContain('Has recibido una invitación a un canal AgentComm')
    expect(html).toContain('Vous êtes invité à rejoindre un canal AgentComm')
    expect(html).toContain('Sie wurden zu einem AgentComm-Kanal eingeladen')
    expect(html).toContain('Você foi convidado para um canal AgentComm')
    expect(html).toContain('Вас пригласили в канал AgentComm')
    expect(html).toContain("document.documentElement.lang = locale === 'zh' ? 'zh-CN' : locale")
  })

  it('serves install.sh and the persistent launcher without relay authentication', async () => {
    const app = freshApp()
    const install = await app.request('https://connect.example.test/install.sh')
    expect(install.status).toBe(200)
    expect(install.headers.get('content-type')).toContain('text/x-shellscript')
    const installScript = await install.text()
    expect(installScript).toContain("AGENTCOMM_DOWNLOAD_BASE='https://connect.example.test'")
    expect(installScript).toContain('$AGENTCOMM_DOWNLOAD_BASE/bin/agentcomm')

    const launcher = await app.request('https://connect.example.test/bin/agentcomm')
    expect(launcher.status).toBe(200)
    const script = await launcher.text()
    expect(script).toContain('agentcomm open [invitation-url]')
    expect(script).toContain('--dangerously-load-development-channels')
    expect(script).toContain('--channels')
    expect(script).toContain('plugin:$ACTIVE_PLUGIN_ID')
  })

  it('uses the browser profile language and builds the command locally with the complete fragment', () => {
    const html = renderJoinPage()
    const openTag = '<script>'
    const scriptStart = html.indexOf(openTag)
    const scriptEnd = html.indexOf('</script>', scriptStart + openTag.length)
    if (scriptStart < 0 || scriptEnd < 0) {
      throw new Error('invitation page is missing its inline script')
    }
    const script = html.slice(scriptStart + openTag.length, scriptEnd)
    const nodes = new Map<string, { textContent: string; value: string; addEventListener: () => void }>()
    const getNode = (id: string) => {
      let node = nodes.get(id)
      if (!node) {
        node = { textContent: '', value: '', addEventListener: () => undefined }
        nodes.set(id, node)
      }
      return node
    }
    const link = 'https://connect.example.test/j/token#k=private-key'
    const window = {
      navigator: {
        languages: ['zh-CN'],
        language: 'en-US',
        clipboard: { writeText: () => Promise.resolve() },
      },
      location: { href: link, origin: 'https://connect.example.test' },
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    }
    const document = {
      documentElement: { lang: '' },
      title: '',
      getElementById: (id: string) => getNode(id),
    }
    vm.runInNewContext(script, { window, document })

    expect(getNode('page-heading').textContent).toBe('你被邀请加入一个 AgentComm 频道')
    expect(getNode('launch-command').textContent).toContain(
      "curl -fsSL 'https://connect.example.test/install.sh'",
    )
    expect(getNode('launch-command').textContent).toContain(`open '${link}'`)
  })

  it('returns byte-identical pages for valid and invalid tokens', async () => {
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
    expect(await validRes.text()).toBe(await invalidRes.text())
  })
})
