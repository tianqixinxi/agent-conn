import { AgentCommError } from '@agent-comm/protocol'

/**
 * W1 实现处:SQLite 持久层(node:sqlite DatabaseSync)。
 * - openStore(path):应用 schema.store.sql,返回各 repo(纯数据存取,无业务规则)
 * - openHubDb(path):应用 schema.hub.sql,返回给 local-home 用的低层句柄
 * - 读 .sql 文件:new URL('./schema.store.sql', import.meta.url) + readFileSync
 * - busy_timeout ≥ 2000ms;多语句写一律事务
 *
 * repo 切分建议(W1 可细化,保持"store 无业务规则"边界):
 *   identityRepo / channelsRepo / peersRepo / messagesRepo / inboxRepo /
 *   syncStateRepo / outboxRepo / invitesRepo / auditRepo
 */
export interface StoreHandle {
  path: string
  close(): void
  // W1:补充各 repo 字段(此接口仅 W1 内部 + engine 使用,不属跨工单契约)
  [k: string]: unknown
}

export function openStore(_path: string): StoreHandle {
  throw new AgentCommError('NOT_IMPLEMENTED', 'store: W1 尚未实现(见 DESIGN.md §6 W1)')
}
