import { AgentCommError } from '@agent-comm/protocol'
import type { HomeDriver } from './api.js'

/**
 * W1 实现处:local 家驱动(D5)。
 * - 打开(必要时初始化)共享 hub 文件(store/schema.hub.sql)
 * - append:单事务内 seq = COALESCE(MAX(seq),0)+1;messageId 幂等
 * - intercept:status='held' 停在家;resolveHeld 放行/丢弃(hub_audit 记录)
 * - pullAfter:只下发已放行消息
 * - busy_timeout ≥ 2000ms;所有多语句写包事务
 */
export function openLocalHome(_hubPath: string): Promise<HomeDriver> {
  throw new AgentCommError('NOT_IMPLEMENTED', 'local-home: W1 尚未实现(见 DESIGN.md §6 W1)')
}
