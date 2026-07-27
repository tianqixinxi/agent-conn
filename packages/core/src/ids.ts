import { randomBytes } from 'node:crypto'

/** Human channel aliases and opaque route ids share the URL-safe naming rule (spec §3.1). */
export const NAME_RE = /^[a-z0-9_-]{1,64}$/

export const MESSAGE_ID_PREFIX = 'm-'
export const NODE_ID_PREFIX = 'n-'
export const CHANNEL_ID_PREFIX = 'c-'
export const RUNTIME_INSTANCE_ID_PREFIX = 'r-'
export const AUTHORIZATION_ID_PREFIX = 'auth-'

export function newMessageId(): string {
  return `${MESSAGE_ID_PREFIX}${randomBytes(16).toString('hex')}`
}

export function newNodeId(): string {
  return `${NODE_ID_PREFIX}${randomBytes(8).toString('hex')}`
}

/** Opaque channel route identity. A channel's human name is not unique. */
export function newChannelId(): string {
  return `${CHANNEL_ID_PREFIX}${randomBytes(12).toString('hex')}`
}

/** Short-lived harness run identifier; it does not own channel membership. */
export function newRuntimeInstanceId(): string {
  return `${RUNTIME_INSTANCE_ID_PREFIX}${randomBytes(12).toString('hex')}`
}

export function newAuthorizationId(): string {
  return `${AUTHORIZATION_ID_PREFIX}${randomBytes(12).toString('hex')}`
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
