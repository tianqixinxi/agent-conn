import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { AgentCommError, isValidName } from '@agent-comm/protocol'

/**
 * profile 解析(D1):身份 = profile(store + keypair)。
 * 解析顺序:显式参数 > AGENT_COMM_PROFILE 环境变量 > 'default'。
 * ⚠️ 严禁从 cwd 派生 profile(EigenFlux 教训:Codex 每 task 换 cwd 会每 task 铸新身份)。
 */

export interface ProfilePaths {
  /** profile 名(= 身份名) */
  name: string
  /** ~/.agent-comm */
  rootDir: string
  /** ~/.agent-comm/profiles/<name> */
  dir: string
  /** 私有 store(单收件箱归属处,D1) */
  storePath: string
  /** Ed25519 私钥文件(0600) */
  identityKeyPath: string
  /** 本机默认 local hub(所有 profile 共享,D5) */
  defaultHubPath: string
}

export interface ResolveProfileOptions {
  profile?: string | undefined
  /** 测试用:覆盖 ~/.agent-comm 根目录 */
  rootDir?: string | undefined
  env?: NodeJS.ProcessEnv
}

export const DEFAULT_INBOX_CAP = 1000
export const DEFAULT_HUB_BASENAME = 'local-hub.db'

/**
 * Claude Channel 的身份默认绑定 Claude session，而不是终端继承的机器级 profile。
 * 同一 session resume 后保持身份；同机打开两个 Claude runtime 时则天然是两个节点。
 * 如确实需要固定身份，可用 --profile 或 AGENT_COMM_CHANNEL_PROFILE 显式覆盖。
 */
export function resolveChannelProfile(opts: ResolveProfileOptions = {}): ProfilePaths {
  const env = opts.env ?? process.env
  const sessionId = env.CLAUDE_CODE_SESSION_ID?.replaceAll('-', '').replace(/[^A-Za-z0-9_]/g, '')
  const sessionProfile = sessionId ? `claude-${sessionId.slice(0, 12)}` : undefined
  return resolveProfile({
    ...opts,
    env,
    profile: opts.profile ?? env.AGENT_COMM_CHANNEL_PROFILE ?? sessionProfile,
  })
}

export function resolveProfile(opts: ResolveProfileOptions = {}): ProfilePaths {
  const env = opts.env ?? process.env
  const name = opts.profile ?? env.AGENT_COMM_PROFILE ?? 'default'
  if (!isValidName(name)) {
    throw new AgentCommError('INVALID_INPUT', `invalid profile name: ${name}`)
  }
  const rootDir = opts.rootDir ?? env.AGENT_COMM_ROOT ?? join(homedir(), '.agent-comm')
  if (!isAbsolute(rootDir)) {
    throw new AgentCommError('INVALID_INPUT', 'AGENT_COMM_ROOT must be absolute')
  }
  const dir = join(rootDir, 'profiles', name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return {
    name,
    rootDir,
    dir,
    storePath: join(dir, 'store.db'),
    identityKeyPath: join(dir, 'identity.key'),
    defaultHubPath: join(rootDir, DEFAULT_HUB_BASENAME),
  }
}
