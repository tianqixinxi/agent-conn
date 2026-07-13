import { AgentCommError } from './errors.js'

/**
 * 邀请链接格式(§2.5/§2.8 + D5):
 * - relay:`https://<relay>/j/<joinToken>#k=<e2eKey b64url>`
 *   e2eKey 只存在于 fragment:HTTP 客户端不上送,引导页不得读取。
 * - local:`agentcomm-local:?path=<hub 绝对路径>&t=<joinToken>`
 *   同机文件即边界,无 e2eKey;不出网。
 */

export type ParsedInvite =
  | { kind: 'relay'; relayUrl: string; joinToken: string; e2eKey?: string }
  | { kind: 'local'; hubPath: string; joinToken: string }

export const LOCAL_SCHEME = 'agentcomm-local:'

export function formatRelayInviteLink(relayUrl: string, joinToken: string, e2eKey?: string): string {
  const base = relayUrl.replace(/\/+$/, '')
  const frag = e2eKey ? `#k=${e2eKey}` : ''
  return `${base}/j/${joinToken}${frag}`
}

export function formatLocalInviteLink(hubPath: string, joinToken: string): string {
  const q = new URLSearchParams({ path: hubPath, t: joinToken })
  return `${LOCAL_SCHEME}?${q.toString()}`
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
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    const u = new URL(trimmed)
    const m = u.pathname.match(/^\/j\/([A-Za-z0-9_-]+)$/)
    if (!m?.[1]) throw new AgentCommError('INVITE_INVALID', 'relay invite link must be <relay>/j/<token>')
    const frag = new URLSearchParams(u.hash.replace(/^#/, ''))
    const e2eKey = frag.get('k') ?? undefined
    return {
      kind: 'relay',
      relayUrl: `${u.protocol}//${u.host}`,
      joinToken: m[1],
      ...(e2eKey ? { e2eKey } : {}),
    }
  }
  throw new AgentCommError('INVITE_INVALID', `unrecognized invite link: ${trimmed.slice(0, 32)}…`)
}
