import { Hono } from 'hono'

/**
 * W4 实现处:邮箱中继(§2.4/§4.2/D3.2)。
 *
 * 职责(DESIGN §3 relay 行):
 * - 存储:node:sqlite 单文件(频道日志密文/成员表/joinToken 哈希/游标/审计;DDL 自定,
 *   与 schema.hub.sql 同构即可,加 icebreak 计数列)
 * - 认证:除 GET /j/<token> 外全部验 WIRE_HEADERS 签名(canonical 见 wire.ts 注释;
 *   Ed25519 verify 用 node:crypto;时钟偏移 ±300s;失败 401 AUTH_FAILED)
 * - `from` 盖戳(§2.3):上行信封的 from 必须等于该 nodeId 在频道内注册的 alias,否则改写并审计
 * - seq:每频道单调(事务内 MAX+1);messageId 幂等
 * - 破冰限流(D3.2):新成员在任一其他成员回应(发消息)前,累计上行 > ICEBREAK_DEFAULTS.maxBeforeReply
 *   → 429 RATE_LIMITED + retryAfterMs
 * - retention:全员 ack 或 TTL 30d(启动时 + 每次写后惰性清理即可,无定时进程)
 * - GET /ch/:channel/messages:?after 起拉;waitMs>0 时 long-poll(setTimeout 轮询 db,间隔 500ms)
 * - GET /j/:token:纯静态引导页(HTML 内联):显示"你被邀请加入频道",给出
 *   `npx agent-comm join "<完整链接>"` 命令(链接由页面 JS 从 location 取,**不读 fragment 上传**,
 *   fragment 仅存在于用户复制的完整 URL 里);无任何外链脚本
 * - 全局:JSON 错误体 = WireErrorSchema;不解析 payload(I1);无账号体系
 *
 * 导出 createApp(deps) 便于测试(内存 sqlite);main.ts 起 @hono/node-server。
 */
export interface RelayDeps {
  dbPath: string
}

export function createApp(_deps: RelayDeps): Hono {
  const app = new Hono()
  app.get('/healthz', (c) => c.json({ ok: true }))
  // W4:按 wire.ts 路由表实现;未实现路由统一 501 {error:{code:'NOT_IMPLEMENTED',…}}
  app.all('*', (c) => c.json({ error: { code: 'NOT_IMPLEMENTED', message: 'relay: W4 尚未实现' } }, 501))
  return app
}
