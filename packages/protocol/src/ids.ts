import { randomBytes } from 'node:crypto'

/** channel 内稳定句柄 / 全局频道名共用的命名规则(spec §3.1) */
export const NAME_RE = /^[a-z0-9_-]{1,64}$/

export const MESSAGE_ID_PREFIX = 'm-'
export const NODE_ID_PREFIX = 'n-'

export function newMessageId(): string {
  return `${MESSAGE_ID_PREFIX}${randomBytes(16).toString('hex')}`
}

export function newNodeId(): string {
  return `${NODE_ID_PREFIX}${randomBytes(8).toString('hex')}`
}

/** 邀请兑换 token(链接路径段;relay/hub 只存其 sha256 哈希) */
export function newJoinToken(): string {
  return randomBytes(24).toString('base64url')
}

export function isValidName(s: string): boolean {
  return NAME_RE.test(s)
}

export function nowIso(): string {
  return new Date().toISOString()
}
