import { createPublicKey, verify as edVerify } from 'node:crypto'
import { WIRE_HEADERS } from '@agent-comm/protocol'
import type { Context, MiddlewareHandler, Next } from 'hono'
import { sha256Hex } from './hash.js'
import { wireError } from './http.js'
import type { RelayDb } from './store.js'
import { findMemberPublicKeyByNodeId } from './store.js'

/**
 * 鉴权中间件(wire.ts 顶部注释,§2.3):
 *   canonical = `${method}\n${pathWithQuery}\n${tsMs}\n${sha256hex(bodyBytes 或空串)}`
 *   Ed25519 签名,publicKey/signature 均 base64url;时钟偏移容忍 ±300s。
 * 不 import agent-comm 的 crypto/identity.ts(信任边界:relay 只依赖 protocol),这里用
 * node:crypto 独立实现一遍验签,字段编码与 wire.ts/entities.ts 注释保持一致
 * (NodeIdentity.publicKey = base64url 编码的 Ed25519 SPKI 公钥)。
 */

const CLOCK_SKEW_MS = 300_000

export function buildCanonical(
  method: string,
  pathWithQuery: string,
  tsMs: number,
  bodyText: string,
): string {
  return `${method}\n${pathWithQuery}\n${tsMs}\n${sha256Hex(bodyText)}`
}

/** 任何格式错误(坏 base64url、坏 DER……)一律按验签失败处理,不向上抛异常 */
export function verifySignature(
  publicKeyB64url: string,
  canonical: string,
  signatureB64url: string,
): boolean {
  try {
    const keyObj = createPublicKey({
      key: Buffer.from(publicKeyB64url, 'base64url'),
      format: 'der',
      type: 'spki',
    })
    const sig = Buffer.from(signatureB64url, 'base64url')
    return edVerify(null, Buffer.from(canonical, 'utf8'), keyObj, sig)
  } catch {
    return false
  }
}

/** 健康检查、安装/公开频道、邀请页与 A2A AgentCard 是公开发现端点，不要求签名。 */
function isPublicRoute(method: string, pathname: string): boolean {
  if (method !== 'GET') return false
  if (pathname === '/' || pathname === '/public') return true
  if (method === 'GET' && pathname === '/healthz') return true
  if (method === 'GET' && pathname === '/.well-known/agent-card.json') return true
  if (pathname.startsWith('/public/') || pathname.startsWith('/api/public/')) return true
  if (pathname.startsWith('/j/') && !pathname.slice(3).includes('/')) return true
  return false
}

/**
 * POST /join 与 POST /ch/:channel/create(relay 自定 bootstrap 端点,见 app.ts 顶部注释)
 * 允许"调用者还不是任何频道的成员"——这两个端点都在请求体里带 `node: {nodeId, publicKey}`,
 * 找不到已注册公钥时退化为用 body 里的公钥验签(TOFU,首次注册即绑定,wire.ts 对 /join 的原话)。
 */
function isBootstrapExemptRoute(method: string, pathname: string): boolean {
  if (method !== 'POST') return false
  if (pathname === '/join') return true
  return /^\/ch\/[^/]+\/create$/.test(pathname)
}

export function createAuthMiddleware(db: RelayDb): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const url = new URL(c.req.url)
    const pathname = url.pathname
    const method = c.req.method

    if (isPublicRoute(method, pathname)) {
      await next()
      return
    }

    const nodeId = c.req.header(WIRE_HEADERS.node)
    const tsHeader = c.req.header(WIRE_HEADERS.ts)
    const signature = c.req.header(WIRE_HEADERS.signature)
    if (!nodeId || !tsHeader || !signature) {
      return wireError(c, 401, 'AUTH_FAILED', 'missing WIRE_HEADERS (node/ts/signature)')
    }

    const tsMs = Number(tsHeader)
    if (!Number.isFinite(tsMs)) {
      return wireError(c, 401, 'AUTH_FAILED', 'invalid x-agentcomm-ts header')
    }
    if (Math.abs(Date.now() - tsMs) > CLOCK_SKEW_MS) {
      return wireError(c, 401, 'AUTH_FAILED', 'clock skew exceeds 300s')
    }

    // 读原始 body 文本算签名哈希;Hono 的 c.req.text()/json() 共享同一份 bodyCache(按 'text'
    // 键缓存),这里读一次之后 handler 里再调 c.req.json() 是安全的,不会二次消费请求流。
    const bodyText = await c.req.text()
    const pathWithQuery = url.pathname + url.search
    const canonical = buildCanonical(method, pathWithQuery, tsMs, bodyText)

    const knownPublicKey = findMemberPublicKeyByNodeId(db, nodeId)
    let publicKey = knownPublicKey
    if (!publicKey) {
      if (!isBootstrapExemptRoute(method, pathname)) {
        return wireError(c, 401, 'AUTH_FAILED', 'unknown node')
      }
      let parsedBody: unknown
      try {
        parsedBody = bodyText ? JSON.parse(bodyText) : undefined
      } catch {
        return wireError(c, 401, 'AUTH_FAILED', 'body is not valid JSON for bootstrap auth')
      }
      const node = (parsedBody as { node?: { nodeId?: unknown; publicKey?: unknown } } | undefined)?.node
      if (!node || typeof node.publicKey !== 'string' || typeof node.nodeId !== 'string') {
        return wireError(c, 401, 'AUTH_FAILED', 'bootstrap request missing body.node.{nodeId,publicKey}')
      }
      if (node.nodeId !== nodeId) {
        return wireError(c, 401, 'AUTH_FAILED', 'x-agentcomm-node header does not match body.node.nodeId')
      }
      publicKey = node.publicKey
    }

    if (!verifySignature(publicKey, canonical, signature)) {
      return wireError(c, 401, 'AUTH_FAILED', 'signature verification failed')
    }

    await next()
  }
}

/** handler 里取已鉴权的 nodeId(auth 中间件已保证 header 存在且验签通过) */
export function requireHeaderNode(c: Context): string {
  const nodeId = c.req.header(WIRE_HEADERS.node)
  if (!nodeId) throw new Error('unreachable: auth middleware should have rejected this request already')
  return nodeId
}
