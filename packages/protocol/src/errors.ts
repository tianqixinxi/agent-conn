/** 全项目统一错误码(节点与 relay 共用;wire 错误体也用它) */
export const ErrorCodes = [
  'NOT_IMPLEMENTED',
  'INVALID_INPUT',
  'CHANNEL_NOT_FOUND',
  'CHANNEL_EXISTS',
  'NOT_MEMBER',
  'ALIAS_TAKEN',
  'INVITE_INVALID',
  'INVITE_EXPIRED',
  'INVITE_EXHAUSTED',
  'SCOPE_DENIED',
  'HOP_EXCEEDED',
  'REPLY_BY_EXPIRED',
  'MESSAGE_NOT_FOUND',
  'NOT_HELD',
  'RATE_LIMITED',
  'AUTH_FAILED',
  'HOME_UNREACHABLE',
  'STORE_BUSY',
  'CONFLICT',
] as const

export type ErrorCode = (typeof ErrorCodes)[number]

export class AgentCommError extends Error {
  readonly code: ErrorCode
  readonly detail?: unknown

  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'AgentCommError'
    this.code = code
    this.detail = detail
  }
}

export function isAgentCommError(e: unknown, code?: ErrorCode): e is AgentCommError {
  return e instanceof AgentCommError && (code === undefined || e.code === code)
}
