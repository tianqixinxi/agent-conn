#!/usr/bin/env node
import process from 'node:process'
import { resolveProfile } from './config.js'

/**
 * 入口分发:`agent-comm serve` = MCP stdio;其余全走 CLI。
 * serve 模式禁止向 stdout 写日志(stdio 是 MCP 通道)——诊断走 stderr。
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === 'serve') {
    const profileFlag = argv.indexOf('--profile')
    const profile = resolveProfile({
      profile: profileFlag >= 0 ? argv[profileFlag + 1] : undefined,
    })
    const { runServe } = await import('./mcp/server.js')
    await runServe(profile)
    return
  }
  const { runCli } = await import('./cli/index.js')
  await runCli(argv)
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`agent-comm: ${msg}\n`)
  process.exitCode = 1
})
