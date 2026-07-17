import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { AgentCommError } from '@agent-comm/protocol'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000

// Keep the two families in separate BlockLists. Node represents IPv4 addresses as mapped IPv6
// values when an IPv6 rule exists in the same list, which can make `::ffff:0:0/96` match every
// ordinary IPv4 address as well.
const blockedIpv4 = new BlockList()
const blockedIpv6 = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4')
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6')
}

function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isLoopbackAddress(address: string, family: 4 | 6): boolean {
  const loopback = new BlockList()
  if (family === 4) {
    loopback.addSubnet('127.0.0.0', 8, 'ipv4')
    return loopback.check(address, 'ipv4')
  }
  loopback.addAddress('::1', 'ipv6')
  return loopback.check(address, 'ipv6')
}

function isLocalhostName(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return lower === 'localhost' || lower.endsWith('.localhost')
}

export function isBlockedRelayAddress(address: string, family: 4 | 6): boolean {
  return family === 4 ? blockedIpv4.check(address, 'ipv4') : blockedIpv6.check(address, 'ipv6')
}

/**
 * Relay URLs are origins, never arbitrary request URLs. Plain HTTP is restricted to loopback for
 * local development; remote relays must use HTTPS. Literal private/reserved addresses are rejected
 * immediately, while hostnames are resolved and pinned again for every request below.
 */
export function normalizeRelayOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (err) {
    throw new AgentCommError('INVALID_INPUT', 'relay URL is not valid', err)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AgentCommError('INVALID_INPUT', 'relay URL must use https (or loopback http)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AgentCommError('INVALID_INPUT', 'relay URL must not contain credentials, query, or fragment')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new AgentCommError('INVALID_INPUT', 'relay URL must be an origin without a path')
  }

  const hostname = unbracket(url.hostname)
  const literalFamily = isIP(hostname)
  const loopbackLiteral = literalFamily !== 0 && isLoopbackAddress(hostname, literalFamily === 4 ? 4 : 6)
  const loopback = isLocalhostName(hostname) || loopbackLiteral
  if (url.protocol === 'http:' && !loopback) {
    throw new AgentCommError('INVALID_INPUT', 'remote relay URLs must use https')
  }
  if (literalFamily !== 0 && isBlockedRelayAddress(hostname, literalFamily === 4 ? 4 : 6) && !loopback) {
    throw new AgentCommError('INVALID_INPUT', 'relay URL must not target a private or reserved address')
  }
  if (url.protocol === 'https:' && loopback) {
    throw new AgentCommError('INVALID_INPUT', 'loopback relay URLs must use http')
  }
  return url.origin
}

async function resolvePinnedAddress(origin: string): Promise<{
  address: string
  family: 4 | 6
  servername?: string | undefined
}> {
  const url = new URL(origin)
  const hostname = unbracket(url.hostname)
  let addresses: LookupAddress[]
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch (err) {
    throw new AgentCommError('HOME_UNREACHABLE', `relay DNS lookup failed: ${(err as Error).message}`, err)
  }
  if (addresses.length === 0) {
    throw new AgentCommError('HOME_UNREACHABLE', 'relay DNS lookup returned no addresses')
  }

  const hostnameFamily = isIP(hostname)
  const literalLoopback = hostnameFamily !== 0 && isLoopbackAddress(hostname, hostnameFamily === 4 ? 4 : 6)
  const allowLoopback = url.protocol === 'http:' && (isLocalhostName(hostname) || literalLoopback)
  for (const item of addresses) {
    const family = item.family === 4 ? 4 : 6
    if (
      allowLoopback ? !isLoopbackAddress(item.address, family) : isBlockedRelayAddress(item.address, family)
    ) {
      throw new AgentCommError('HOME_UNREACHABLE', 'relay resolved to a private or reserved address')
    }
  }

  const selected = addresses[0]
  if (!selected) throw new AgentCommError('HOME_UNREACHABLE', 'relay DNS lookup returned no addresses')
  return {
    address: selected.address,
    family: selected.family === 4 ? 4 : 6,
    ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
  }
}

export interface SafeRelayResponse {
  ok: boolean
  status: number
  text: string
}

/** Resolve, validate, then connect to that exact IP so DNS rebinding cannot redirect the request. */
export async function safeRelayRequest(
  origin: string,
  method: 'GET' | 'POST',
  pathWithQuery: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<SafeRelayResponse> {
  const normalizedOrigin = normalizeRelayOrigin(origin)
  if (!pathWithQuery.startsWith('/') || pathWithQuery.startsWith('//')) {
    throw new AgentCommError('INVALID_INPUT', 'relay request path must be origin-relative')
  }
  const target = new URL(pathWithQuery, `${normalizedOrigin}/`)
  if (target.origin !== normalizedOrigin || target.username || target.password || target.hash) {
    throw new AgentCommError('INVALID_INPUT', 'relay request attempted to escape the trusted origin')
  }

  const pinned = await resolvePinnedAddress(normalizedOrigin)
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise((resolve, reject) => {
    // The connection target is a DNS result that was checked against the complete private/reserved
    // blocklist above and is pinned for this request. The original hostname is used only for TLS SNI
    // and the Host header. lgtm[js/request-forgery]
    const req = request(
      {
        protocol: target.protocol,
        hostname: pinned.address,
        family: pinned.family,
        port: target.port || undefined,
        method,
        path: `${target.pathname}${target.search}`,
        headers: { ...headers, host: target.host },
        ...(target.protocol === 'https:' && pinned.servername ? { servername: pinned.servername } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error(`relay response exceeds ${MAX_RESPONSE_BYTES} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          resolve({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('relay request timed out')))
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
