import type { NodeIdentity } from '@agent-comm/protocol'
import { AgentCommError } from '@agent-comm/protocol'

/**
 * W3 实现处:NodeIdentity(§2.3)。全部用 node:crypto,零外部依赖(D4)。
 * - ensureIdentity:首次生成 Ed25519 keypair;私钥 PKCS8 PEM 写 identityKeyPath(0600);
 *   公钥 SPKI DER base64url;nodeId = newNodeId();幂等(已存在则加载)。
 * - signCanonical / verifyCanonical:wire.ts 签名规范
 *   `${method}\n${pathWithQuery}\n${tsMs}\n${sha256hex(body)}`
 */
export function ensureIdentity(_paths: { identityKeyPath: string }): Promise<NodeIdentity> {
  throw new AgentCommError('NOT_IMPLEMENTED', 'crypto/identity: W3 尚未实现(见 DESIGN.md §6 W3)')
}

export function signCanonical(_identityKeyPath: string, _canonical: string): Promise<string> {
  throw new AgentCommError('NOT_IMPLEMENTED', 'crypto/identity: W3 尚未实现')
}

export function verifyCanonical(
  _publicKeyB64url: string,
  _canonical: string,
  _signatureB64url: string,
): boolean {
  throw new AgentCommError('NOT_IMPLEMENTED', 'crypto/identity: W3 尚未实现')
}
