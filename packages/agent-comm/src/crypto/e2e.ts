import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { CipherPayload } from '@agent-comm/protocol'
import { AgentCommError } from '@agent-comm/protocol'

/**
 * W3 实现处:E2E(§2.5,M2)。AES-256-GCM(node:crypto)。
 * - e2eKey:32 字节随机,base64url 随邀请链接 fragment 走
 * - seal:明文 = JSON.stringify({ payload, contentType });iv 12B;输出 CipherPayload
 * - open:失败抛 AUTH_FAILED(密文被改/密钥不对)
 * - 密钥本地保存:profile 目录 keys/<channel>.key(0600);store.channels.e2e_key_ref 存文件引用
 *
 * CipherPayloadSchema(wire.ts)只有 { enc, iv, ct } 三个字段,没有单独的 authTag 位置:
 * ct = base64url(密文 || authTag)拼接编码,open 时按尾部固定 16 字节切回 authTag。
 */

const ALGO = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

/** 生成 32 字节随机 E2E 组密钥,base64url 编码(随邀请链接 fragment 走,relay 不落地) */
export function newE2eKey(): string {
  return randomBytes(KEY_BYTES).toString('base64url')
}

/** 仅做格式校验,不做语义区分(调用方决定校验失败时对外报什么错) */
function decodeKeyStrict(e2eKeyB64url: string): Buffer {
  const key = Buffer.from(e2eKeyB64url, 'base64url')
  if (key.length !== KEY_BYTES) {
    throw new Error(`e2eKey must decode to ${KEY_BYTES} bytes, got ${key.length}`)
  }
  return key
}

/** 加密 payload+contentType → CipherPayload(路由字段明文,内容密文,§2.5) */
export function seal(e2eKeyB64url: string, payload: unknown, contentType?: string): CipherPayload {
  let key: Buffer
  try {
    key = decodeKeyStrict(e2eKeyB64url)
  } catch (err) {
    throw new AgentCommError('INVALID_INPUT', `crypto/e2e seal: ${(err as Error).message}`, err)
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const plaintext = Buffer.from(JSON.stringify({ payload, contentType }), 'utf8')
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    enc: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    ct: Buffer.concat([encrypted, authTag]).toString('base64url'),
  }
}

/**
 * 解密 CipherPayload → { payload, contentType }。
 * 失败一律折叠成 AUTH_FAILED(密文被改/密钥不对/格式不对——不对外区分,避免侧信道)。
 */
export function open(
  e2eKeyB64url: string,
  cipher: CipherPayload,
): { payload: unknown; contentType?: string | undefined } {
  try {
    const key = decodeKeyStrict(e2eKeyB64url)
    const iv = Buffer.from(cipher.iv, 'base64url')
    const raw = Buffer.from(cipher.ct, 'base64url')
    if (iv.length !== IV_BYTES || raw.length < AUTH_TAG_BYTES) {
      throw new Error('malformed CipherPayload: bad iv/ct length')
    }
    const authTag = raw.subarray(raw.length - AUTH_TAG_BYTES)
    const encrypted = raw.subarray(0, raw.length - AUTH_TAG_BYTES)
    const decipher = createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
    const parsed = JSON.parse(decrypted.toString('utf8')) as { payload: unknown; contentType?: string }
    return { payload: parsed.payload, contentType: parsed.contentType }
  } catch (err) {
    throw new AgentCommError('AUTH_FAILED', 'e2e open failed: ciphertext invalid or key mismatch', err)
  }
}
