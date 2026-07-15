import { createHash, sign as cryptoSign, generateKeyPairSync } from 'node:crypto'
import { type MessageEnvelope, newMessageId, WIRE_HEADERS } from '@agent-comm/protocol'
import type { Hono } from 'hono'
import { createApp } from '../src/app.js'

/**
 * relay 测试专用签名身份 + 请求构造工具。独立实现 sha256/签名(不复用 src/hash.ts /
 * src/auth.ts 的内部函数),这样测试才真正在验证被测代码,而不是自己验证自己。
 */

let idCounter = 0

export interface TestIdentity {
  nodeId: string
  publicKeyB64url: string
  sign(method: string, pathWithQuery: string, tsMs: number, bodyText: string): string
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export function makeIdentity(label = 'node'): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyB64url = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  idCounter += 1
  const nodeId = `n-test-${label}-${idCounter}`
  return {
    nodeId,
    publicKeyB64url,
    sign(method, pathWithQuery, tsMs, bodyText) {
      const canonical = `${method}\n${pathWithQuery}\n${tsMs}\n${sha256Hex(bodyText)}`
      return cryptoSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64url')
    },
  }
}

export interface SignedRequestOptions {
  /** 覆盖时间戳(ms);默认 Date.now() */
  tsMs?: number
  /** 覆盖签名头(用来测试"签名错误"这一类场景) */
  signatureOverride?: string
  /** 覆盖 node 头(用来测试"header 与 body 不一致"这一类场景) */
  nodeIdOverride?: string
  /** 强制带上 content-type + body(即便 body 是 undefined,也序列化成 '{}') */
  forceEmptyObjectBody?: boolean
}

/** 构造 app.request() 的第二个参数(method/headers/body),按 wire.ts 的 canonical 规则签名 */
export function signedRequest(
  identity: TestIdentity,
  method: string,
  pathWithQuery: string,
  body?: unknown,
  opts: SignedRequestOptions = {},
): RequestInit {
  const effectiveBody = body === undefined && opts.forceEmptyObjectBody ? {} : body
  const bodyText = effectiveBody === undefined ? '' : JSON.stringify(effectiveBody)
  const tsMs = opts.tsMs ?? Date.now()
  const signature = opts.signatureOverride ?? identity.sign(method, pathWithQuery, tsMs, bodyText)
  const headers: Record<string, string> = {
    [WIRE_HEADERS.node]: opts.nodeIdOverride ?? identity.nodeId,
    [WIRE_HEADERS.ts]: String(tsMs),
    [WIRE_HEADERS.signature]: signature,
  }
  const init: RequestInit = { method, headers }
  if (effectiveBody !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = bodyText
  }
  return init
}

/** 全新内存 relay app(每个测试独立数据库,互不干扰) */
export function freshApp(opts: { enableA2AIngress?: boolean } = {}): Hono {
  return createApp({ dbPath: ':memory:', ...opts })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 造一条合法信封(MessageEnvelopeSchema 形状),省得每个测试都手写全部字段 */
export function makeEnvelope(input: {
  from: string
  to: string
  channel: string
  messageId?: string
  traceId?: string
  hop?: number
  payload?: unknown
  injectedByHuman?: boolean
  ts?: string
  contentType?: string
  replyTo?: string
  replyBy?: string
}): MessageEnvelope {
  return {
    messageId: input.messageId ?? newMessageId(),
    from: input.from,
    to: input.to,
    channel: input.channel,
    traceId: input.traceId ?? newMessageId(),
    hop: input.hop ?? 0,
    payload: input.payload ?? { text: 'hello' },
    injectedByHuman: input.injectedByHuman ?? false,
    ts: input.ts ?? new Date().toISOString(),
    contentType: input.contentType,
    replyTo: input.replyTo,
    replyBy: input.replyBy,
  }
}
