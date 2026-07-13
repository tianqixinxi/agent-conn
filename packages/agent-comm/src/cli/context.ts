import type { ProfilePaths } from '../config.js'
import { resolveProfile } from '../config.js'
import type { Engine } from '../engine/api.js'
import type { HostEnv } from './host.js'
import { defaultHostEnv } from './host.js'

/**
 * CLI 每次调用共享的上下文:由 runCli 的 preAction hook 建一次,所有子命令共用。
 * engine/hostEnv/stdout/stderr 都可注入——这是给测试用的缝(见 packages/agent-comm/test)。
 */
export interface CliContext {
  profile: ProfilePaths
  engine: Engine
  json: boolean
  stdout: (chunk: string) => void
  stderr: (chunk: string) => void
  hostEnv: HostEnv
}

export interface CreateCliContextOptions {
  profile?: string | undefined
  /** 测试用:覆盖 ~/.agent-comm 根目录(透传给 resolveProfile) */
  rootDir?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  json?: boolean | undefined
  /** 测试注入:跳过生产的 createEngine(profile),直接给一个(通常是 fake)Engine 工厂 */
  engineFactory?: ((profile: ProfilePaths) => Promise<Engine>) | undefined
  stdout?: ((chunk: string) => void) | undefined
  stderr?: ((chunk: string) => void) | undefined
  hostEnv?: HostEnv | undefined
}

/**
 * 生产用的 Engine 工厂:动态 import(不在文件顶层静态 import engine.ts)——
 * 避免过早加载 node:sqlite,让 runCli 里的 process.removeAllListeners('warning') 真正"前置"。
 * doctor 命令自己做分步诊断,绕过 createCliContext,但仍复用这个工厂,故导出。
 */
export async function productionEngineFactory(profile: ProfilePaths): Promise<Engine> {
  const { createEngine } = await import('../engine/engine.js')
  return createEngine(profile)
}

export async function createCliContext(opts: CreateCliContextOptions): Promise<CliContext> {
  const profile = resolveProfile({ profile: opts.profile, rootDir: opts.rootDir, env: opts.env })
  const engineFactory = opts.engineFactory ?? productionEngineFactory
  const engine = await engineFactory(profile)
  return {
    profile,
    engine,
    json: opts.json ?? false,
    stdout: opts.stdout ?? ((chunk: string) => void process.stdout.write(chunk)),
    stderr: opts.stderr ?? ((chunk: string) => void process.stderr.write(chunk)),
    hostEnv: opts.hostEnv ?? defaultHostEnv,
  }
}
