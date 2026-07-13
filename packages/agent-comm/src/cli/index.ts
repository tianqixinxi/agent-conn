import { AgentCommError } from '@agent-comm/protocol'

/**
 * W2 实现处:CLI 伴侣(人类面,T3 + 引导;DESIGN §3)。commander。
 *
 * 命令树(全局 --profile <name>,默认 env/‘default’):
 *   init                          生成身份(幂等),打印 nodeId
 *   join <link> [--alias <a>]     兑换邀请(R10 引导:检测 Claude Code/Codex,
 *                                 提示/执行 MCP 注册命令;D8:绝不写持久指令/定时任务)
 *   invite <channel> [--ttl --max-uses]   铸邀请链接(打印给人转发)
 *   channels [ls|create|mode <channel> <mode>]
 *   peers <channel>
 *   inbox [--consume --channel …] 人读收件箱
 *   send <channel> <to> <text>    人工注入(injectedByHuman: true,audit 'injected')
 *   held [ls]                     待放行消息列表
 *   deliver <messageId> / drop <messageId> / edit <messageId> --payload <json>   T3(actor 'human')
 *   audit [--channel --since]     审计查询
 *   doctor                        环境诊断(store 可写/hub 可达/宿主配置存在)
 *
 * 输出:人读为主,--json 给脚本;T3 动作打印 audit 摘要。
 */
export async function runCli(_argv: string[]): Promise<void> {
  throw new AgentCommError('NOT_IMPLEMENTED', 'cli: W2 尚未实现(见 DESIGN.md §6 W2)')
}
