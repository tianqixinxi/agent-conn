import { sign as edSign, generateKeyPairSync } from 'node:crypto'
import type { NodeIdentity } from '@agent-comm/protocol'

/**
 * 测试专用:生成 Ed25519 身份 + signRequest 回调。
 * 不经 crypto/identity.ts(那是 W1 的活,且当前还是 NOT_IMPLEMENTED 桩);
 * 私钥只存在这个闭包里,不落盘,驱动本身也不管私钥(签名经回调注入)。
 */
export interface TestIdentity {
  identity: NodeIdentity
  signRequest: (canonical: string) => Promise<string>
}

let seq = 0

export function generateTestIdentity(nodeId?: string): TestIdentity {
  seq += 1
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyB64url = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const identity: NodeIdentity = {
    nodeId: nodeId ?? `n-test-${seq}`,
    publicKey: publicKeyB64url,
    privateKeyRef: 'test-only-in-memory',
    relays: [],
  }
  const signRequest = async (canonical: string): Promise<string> => {
    const signature = edSign(null, Buffer.from(canonical, 'utf8'), privateKey)
    return signature.toString('base64url')
  }
  return { identity, signRequest }
}
