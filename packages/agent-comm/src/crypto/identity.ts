import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'
import type { NodeIdentity } from '@agent-comm/protocol'
import { NODE_ID_PREFIX } from '@agent-comm/protocol'
import { createPrivateFile, readPrivateFile } from './secure-file.js'

/**
 * W1 实现处:NodeIdentity(§2.3)。全部用 node:crypto,零外部依赖(D4)。
 * - ensureIdentity:首次生成 Ed25519 keypair;私钥 PKCS8 PEM 写 identityKeyPath(0600);
 *   公钥 SPKI DER base64url;幂等加载。
 * - nodeId 从公钥派生(sha256(publicKey) 前 32 hex),而不是随机生成后另外存档:
 *   这样"幂等加载"只需要私钥文件本身即可完整复原身份,不必再引入第二个状态文件。
 * - signCanonical / verifyCanonical:wire.ts 签名规范
 *   `${method}\n${pathWithQuery}\n${tsMs}\n${sha256hex(body)}`(canonical 由调用方拼好传入)
 *   Ed25519 是"一把梭"签名(内部自带哈希),node:crypto 的 sign/verify 传 algorithm=null 即可。
 */

function deriveNodeId(publicKeyB64url: string): string {
  const digest = createHash('sha256').update(publicKeyB64url).digest('hex')
  return `${NODE_ID_PREFIX}${digest.slice(0, 32)}`
}

function exportPublicKeyB64url(key: KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' })
  return der.toString('base64url')
}

function identityFromPrivateKeyObject(privateKeyObj: KeyObject, identityKeyPath: string): NodeIdentity {
  const exportedPrivateKey = privateKeyObj.export({ type: 'pkcs8', format: 'pem' })
  const publicKeyObj = createPublicKey(exportedPrivateKey)
  const publicKey = exportPublicKeyB64url(publicKeyObj)
  return { nodeId: deriveNodeId(publicKey), publicKey, privateKeyRef: identityKeyPath, relays: [] }
}

export async function ensureIdentity(paths: { identityKeyPath: string }): Promise<NodeIdentity> {
  const { identityKeyPath } = paths
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  if (typeof pem !== 'string') {
    throw new TypeError('unexpected non-string PKCS8 PEM export for ed25519 private key')
  }
  if (createPrivateFile(identityKeyPath, pem)) {
    return identityFromPrivateKeyObject(privateKey, identityKeyPath)
  }
  const existingPem = readPrivateFile(identityKeyPath)
  return identityFromPrivateKeyObject(createPrivateKey(existingPem), identityKeyPath)
}

export async function signCanonical(identityKeyPath: string, canonical: string): Promise<string> {
  const pem = readPrivateFile(identityKeyPath)
  const privateKeyObj = createPrivateKey(pem)
  const signature = cryptoSign(null, Buffer.from(canonical, 'utf8'), privateKeyObj)
  return signature.toString('base64url')
}

export function verifyCanonical(
  publicKeyB64url: string,
  canonical: string,
  signatureB64url: string,
): boolean {
  try {
    const der = Buffer.from(publicKeyB64url, 'base64url')
    const publicKeyObj = createPublicKey({ key: der, format: 'der', type: 'spki' })
    const signature = Buffer.from(signatureB64url, 'base64url')
    return cryptoVerify(null, Buffer.from(canonical, 'utf8'), publicKeyObj, signature)
  } catch {
    return false
  }
}
