import { createHash } from 'node:crypto'

/** sha256 hex(utf8 编码);joinToken 兑换态哈希 + 签名 canonical 串的 body 哈希共用 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}
