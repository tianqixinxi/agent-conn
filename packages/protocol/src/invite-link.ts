import { AgentCommError } from './errors.js'

/**
 * 邀请链接格式(§2.5/§2.8 + D5):
 * - relay:`https://<relay>/j/<joinToken>#k=<e2eKey b64url>`
 *   e2eKey 只存在于 fragment:HTTP 客户端不上送,引导页不得读取。
 * - local:`agentcomm-local:?path=<hub 绝对路径>&t=<joinToken>`
 *   同机文件即边界,无 e2eKey;不出网。
 * - pluggable transport:`agentcomm-transport:?home=<encoded nats/slim URL>&t=<token>#k=<e2eKey>`
 *   非浏览器邀请，交给已注册的 TransportBindingFactory。
 */

export type ParsedInvite =
  | {
      kind: 'relay'
      relayUrl: string
      joinToken: string
      visibility: 'private' | 'public'
      e2eKey?: string
    }
  | { kind: 'local'; hubPath: string; joinToken: string }
  | { kind: 'transport'; home: string; joinToken: string; e2eKey?: string }

export const LOCAL_SCHEME = 'agentcomm-local:'
export const TRANSPORT_SCHEME = 'agentcomm-transport:'

function isUrlSafeToken(value: string): boolean {
  if (value.length === 0) return false
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    const valid =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      code === 95 ||
      (code >= 97 && code <= 122) ||
      code === 45
    if (!valid) return false
  }
  return true
}

function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return value.slice(0, end)
}

export function formatRelayInviteLink(
  relayUrl: string,
  joinToken: string,
  e2eKey?: string,
  visibility: 'private' | 'public' = 'private',
): string {
  const base = trimTrailingSlashes(relayUrl)
  const fragment = new URLSearchParams()
  if (e2eKey) fragment.set('k', e2eKey)
  if (visibility === 'public') fragment.set('v', 'public')
  const frag = fragment.size > 0 ? `#${fragment.toString()}` : ''
  return `${base}/j/${joinToken}${frag}`
}

export function formatLocalInviteLink(hubPath: string, joinToken: string): string {
  const q = new URLSearchParams({ path: hubPath, t: joinToken })
  return `${LOCAL_SCHEME}?${q.toString()}`
}

/** Non-browser transport invitation used by registered NATS/SLIM bindings. */
export function formatTransportInviteLink(home: string, joinToken: string, e2eKey?: string): string {
  const q = new URLSearchParams({ home, t: joinToken })
  const frag = e2eKey ? `#k=${e2eKey}` : ''
  return `${TRANSPORT_SCHEME}?${q.toString()}${frag}`
}

export function parseInviteLink(link: string): ParsedInvite {
  const trimmed = link.trim()
  if (trimmed.startsWith(LOCAL_SCHEME)) {
    const u = new URL(trimmed)
    const hubPath = u.searchParams.get('path')
    const joinToken = u.searchParams.get('t')
    if (!hubPath || !joinToken) {
      throw new AgentCommError('INVITE_INVALID', 'local invite link missing path or token')
    }
    return { kind: 'local', hubPath, joinToken }
  }
  if (trimmed.startsWith(TRANSPORT_SCHEME)) {
    const u = new URL(trimmed)
    const home = u.searchParams.get('home')
    const joinToken = u.searchParams.get('t')
    if (!home || !joinToken || (!home.startsWith('nats://') && !home.startsWith('slim://'))) {
      throw new AgentCommError('INVITE_INVALID', 'transport invite link has invalid home or token')
    }
    const frag = new URLSearchParams(u.hash.replace(/^#/, ''))
    const e2eKey = frag.get('k') ?? undefined
    return {
      kind: 'transport',
      home,
      joinToken,
      ...(e2eKey ? { e2eKey } : {}),
    }
  }
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    const u = new URL(trimmed)
    const prefix = '/j/'
    const joinToken = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : ''
    if (!isUrlSafeToken(joinToken)) {
      throw new AgentCommError('INVITE_INVALID', 'relay invite link must be <relay>/j/<token>')
    }
    const frag = new URLSearchParams(u.hash.replace(/^#/, ''))
    const e2eKey = frag.get('k') ?? undefined
    const visibilityValue = frag.get('v')
    if (visibilityValue !== null && visibilityValue !== 'public' && visibilityValue !== 'private') {
      throw new AgentCommError('INVITE_INVALID', 'relay invite link has invalid visibility')
    }
    const visibility = visibilityValue === 'public' ? 'public' : 'private'
    return {
      kind: 'relay',
      relayUrl: `${u.protocol}//${u.host}`,
      joinToken,
      visibility,
      ...(e2eKey ? { e2eKey } : {}),
    }
  }
  throw new AgentCommError('INVITE_INVALID', `unrecognized invite link: ${trimmed.slice(0, 32)}…`)
}
