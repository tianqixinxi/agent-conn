import { AgentCommError } from '@agent-comm/protocol'
import type { RelayDriverFactory } from '../engine/api.js'

/**
 * W3 实现处:relay 家驱动(§2.4 客户端,M2)。
 * - fetch(Node 内建)实现 wire.ts 三端点 + join/invites/members/card;签名头见 WIRE_HEADERS
 * - append 前若频道有 e2eKey:crypto/e2e.seal 替换 payload(contentType 併入密文)
 * - pullAfter 后对 CipherPayload 解封再交回 engine
 * - 网络失败抛 HOME_UNREACHABLE(engine 保消息于 outbox,下轮重试;I3)
 * - SSE 存活期推送(§2.6)与 long-poll 二选一,v1 先 long-poll
 */
export const createRelayDriver: RelayDriverFactory = (_input) => {
  throw new AgentCommError('NOT_IMPLEMENTED', 'sync/relay-driver: W3 尚未实现(见 DESIGN.md §6 W3)')
}
