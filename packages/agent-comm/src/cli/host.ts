import { execFileSync } from 'node:child_process'

/**
 * 宿主探测/注册的可替换环境(测试注入缝):`join`/`doctor` 都要"看看 claude/codex 在不在"、
 * 且 `join --register` 要能真的跑注册命令——两者都不适合在单测里碰真实子进程,所以抽成接口,
 * 生产用 execFileSync,测试传假实现。
 */
export interface HostEnv {
  /** 探测某宿主 CLI 是否可执行 */
  detect(bin: string): boolean
  /** 执行宿主注册命令(仅 --register 时调用) */
  exec(bin: string, args: string[]): void
}

export const defaultHostEnv: HostEnv = {
  detect(bin) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },
  exec(bin, args) {
    execFileSync(bin, args, { stdio: 'inherit' })
  },
}

export interface HostRegistration {
  host: 'claude' | 'codex'
  /** 给人看的说明;--register 未给时只打印这个 */
  instructions: string
  /** --register 时真正执行的命令;codex 目前没有确认过"不写宿主持久指令文件"的注册子命令,留空 = 不执行 */
  run?: { bin: string; args: string[] } | undefined
}

/**
 * 探测本机已装的宿主 CLI,给出注册建议(R10 引导 + D8 安装边界):
 * - claude:`claude mcp add agent-comm -- npx -y agent-comm serve`。这是调用宿主自己的 CLI 去改
 *   它自己的配置,不是我们直接写宿主的持久指令文件,--register 时可以真的执行。
 * - codex:官方 CLI 是否有等价的"添加 MCP server"子命令,未在本仓库文档内确认过;如果只能靠直接
 *   编辑 `~/.codex/config.toml` 来注册,那属于 D8 明令禁止的"写宿主持久指令文件"。因此 codex 分支
 *   只打印手动配置提示,--register 对它不执行任何操作(见最终汇报的"契约问题")。
 */
export function detectHostRegistrations(env: HostEnv = defaultHostEnv): HostRegistration[] {
  const found: HostRegistration[] = []
  if (env.detect('claude')) {
    found.push({
      host: 'claude',
      instructions:
        '检测到 Claude Code。注册 agent-comm 为 MCP server:\n  claude mcp add agent-comm -- npx -y agent-comm serve',
      run: { bin: 'claude', args: ['mcp', 'add', 'agent-comm', '--', 'npx', '-y', 'agent-comm', 'serve'] },
    })
  }
  if (env.detect('codex')) {
    found.push({
      host: 'codex',
      instructions:
        '检测到 codex。codex 的 MCP 注册命令未在本仓库文档中确认,请参考 codex 官方文档手动配置\n' +
        '  (通常是在 ~/.codex/config.toml 添加一段 [mcp_servers.agent-comm],' +
        'command = "npx", args = ["-y", "agent-comm", "serve"])。',
      // 未确认过安全的非文件写入注册方式,--register 对 codex 不执行任何操作(D8)。
    })
  }
  return found
}
