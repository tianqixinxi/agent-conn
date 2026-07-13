import { AgentCommError } from '@agent-comm/protocol'
import type { ProfilePaths } from '../config.js'

/**
 * W2 实现处:`agent-comm serve`(stdio MCP server,spec §5/§7.1)。
 * - @modelcontextprotocol/sdk:McpServer + StdioServerTransport
 * - 注册 tools.ts 全部 12 工具 → createEngine() → 调 Engine;actor = `agent:<alias>`
 *   (send/read_inbox 用当前频道 alias;多频道时 whoami.memberships 取)
 * - intercept 放行(F4):sync 后发现本频道 held 且我是家上的成员 →
 *   server.server.elicitInput() 请人 accept/edit/reject → engine.deliverHeld/editHeld/dropHeld
 *   (elicitation 响应路径是合法人工门 §7.1;宿主不支持 elicitation 时降级:提示用 CLI)
 * - onInboxChange → sendToolListChanged? 不:用 notifications/message(logging)或
 *   resource updated 通知;宿主支持有限,v1 尽力而为即可(§2.6 拉基线兜底)
 * - 进程退出前 engine.close()
 */
export async function runServe(_profile: ProfilePaths): Promise<void> {
  throw new AgentCommError('NOT_IMPLEMENTED', 'mcp/server: W2 尚未实现(见 DESIGN.md §6 W2)')
}
