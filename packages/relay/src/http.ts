import type { ErrorCode } from '@agent-comm/protocol'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * WireErrorSchema 响应体 + 状态码语义化(工单:"404/401/409/429 语义化")。
 * ErrorCodes 是 protocol 冻结的全项目错误码表,这里只做"错误码 → HTTP 状态"的映射,
 * relay 不新增错误码。
 */
export function errorStatus(code: ErrorCode): ContentfulStatusCode {
  switch (code) {
    case 'AUTH_FAILED':
      return 401
    case 'CHANNEL_NOT_FOUND':
    case 'INVITE_INVALID':
    case 'MESSAGE_NOT_FOUND':
      return 404
    case 'NOT_MEMBER':
    case 'SCOPE_DENIED':
      return 403
    case 'ALIAS_TAKEN':
    case 'CHANNEL_EXISTS':
    case 'INVITE_EXPIRED':
    case 'INVITE_EXHAUSTED':
    case 'CONFLICT':
    case 'NOT_HELD':
      return 409
    case 'RATE_LIMITED':
      return 429
    case 'INVALID_INPUT':
    case 'HOP_EXCEEDED':
    case 'REPLY_BY_EXPIRED':
      return 400
    case 'HOME_UNREACHABLE':
      return 502
    case 'STORE_BUSY':
      return 503
    case 'NOT_IMPLEMENTED':
      return 501
    default:
      return 500
  }
}

/** 供鉴权中间件在 Hono handler 之外直接构造 WireErrorSchema 响应(不经 AgentCommError) */
export function wireError(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status)
}
