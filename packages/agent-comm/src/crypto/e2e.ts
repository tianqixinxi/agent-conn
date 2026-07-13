import type { CipherPayload } from '@agent-comm/protocol'
import { AgentCommError } from '@agent-comm/protocol'

/**
 * W3 实现处:E2E(§2.5,M2)。AES-256-GCM(node:crypto)。
 * - e2eKey:32 字节随机,base64url 随邀请链接 fragment 走
 * - seal:明文 = JSON.stringify({ payload, contentType });iv 12B;输出 CipherPayload
 * - open:失败抛 AUTH_FAILED(密文被改/密钥不对)
 * - 密钥本地保存:profile 目录 keys/<channel>.key(0600);store.channels.e2e_key_ref 存文件引用
 */
export function newE2eKey(): string {
  throw new AgentCommError('NOT_IMPLEMENTED', 'crypto/e2e: W3 尚未实现(见 DESIGN.md §6 W3)')
}

export function seal(_e2eKeyB64url: string, _payload: unknown, _contentType?: string): CipherPayload {
  throw new AgentCommError('NOT_IMPLEMENTED', 'crypto/e2e: W3 尚未实现')
}

export function open(
  _e2eKeyB64url: string,
  _cipher: CipherPayload,
): { payload: unknown; contentType?: string | undefined } {
  throw new AgentCommError('NOT_IMPLEMENTED', 'crypto/e2e: W3 尚未实现')
}
