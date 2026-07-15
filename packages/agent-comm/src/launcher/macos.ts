import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentCommError, parseInviteLink } from '@agent-comm/protocol'

const APP_NAME = 'AgentComm Launcher.app'
const PLIST_BUDDY = '/usr/libexec/PlistBuddy'
const LS_REGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function runChecked(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`
    throw new AgentCommError('NOT_IMPLEMENTED', `${command} failed: ${detail}`)
  }
  return result.stdout.trim()
}

export function findPluginRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let current = start
  for (;;) {
    if (existsSync(join(current, '.claude-plugin', 'plugin.json'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new AgentCommError('NOT_IMPLEMENTED', '找不到 agent-comm plugin root')
}

export interface LauncherTarget {
  invite: string
  relayUrl: string
}

export function parseLauncherUrl(rawUrl: string): LauncherTarget {
  let launcher: URL
  try {
    launcher = new URL(rawUrl)
  } catch {
    throw new AgentCommError('INVITE_INVALID', 'invalid agentcomm launcher URL')
  }
  if (launcher.protocol !== 'agentcomm:' || launcher.hostname !== 'open') {
    throw new AgentCommError('INVITE_INVALID', 'launcher URL must be agentcomm://open')
  }
  const invite = launcher.searchParams.get('invite')
  if (!invite) throw new AgentCommError('INVITE_INVALID', 'launcher URL missing invite')
  const parsed = parseInviteLink(invite)
  if (parsed.kind !== 'relay') {
    throw new AgentCommError('INVITE_INVALID', 'browser launcher requires an HTTP relay invitation')
  }
  return { invite, relayUrl: parsed.relayUrl }
}

export interface ClaudeLaunchInput extends LauncherTarget {
  claudeBin: string
  pluginRoot: string
  profile?: string | undefined
}

export function buildClaudeLaunchCommand(input: ClaudeLaunchInput): string {
  const profile = input.profile && input.profile !== 'auto' ? input.profile : undefined
  const prompt = [
    'This session was opened from an AgentComm invitation.',
    'Use the AgentComm integration to connect with the invitation below.',
    'The integration will require one host-enforced yes/no permission before establishing this new trust relationship.',
    'After connecting, process safe channel work automatically and surface only permission or governance approvals.',
    '',
    input.invite,
  ].join('\n')

  const env = [
    '/usr/bin/env',
    // 根目录同时是 project MCP config 与 plugin source；server:agent-comm 走前者，
    // 因此本地开发 launcher 必须显式提供该变量供 .mcp.json 展开。
    `CLAUDE_PLUGIN_ROOT=${shellQuote(input.pluginRoot)}`,
    ...(profile
      ? [
          `AGENT_COMM_CHANNEL_PROFILE=${shellQuote(profile)}`,
          `AGENT_COMM_CHANNEL_ALIAS=${shellQuote(profile)}`,
        ]
      : []),
    `AGENT_COMM_RELAY_URL=${shellQuote(input.relayUrl)}`,
  ]
  const launch = [
    'cd',
    shellQuote(input.pluginRoot),
    '&&',
    ...env,
    shellQuote(input.claudeBin),
    // development channels 参数是 variadic；prompt 必须放在它前面，否则会被误判为另一个 entry。
    shellQuote(prompt),
    '--plugin-dir',
    shellQuote(input.pluginRoot),
    '--dangerously-load-development-channels',
    'server:agent-comm',
  ].join(' ')
  return `printf '\\nStarting AgentComm + Claude Code…\\n\\n'; ${launch}`
}

export function buildLauncherAppleScript(input: {
  acBin: string
  claudeBin: string
  nodeBin: string
  profile?: string | undefined
  logPath?: string | undefined
}): string {
  const path = [dirname(input.nodeBin), dirname(input.claudeBin), '/usr/bin', '/bin'].join(':')
  const bootstrap = [
    '/usr/bin/env',
    `PATH=${shellQuote(path)}`,
    `AGENT_COMM_CLAUDE_BIN=${shellQuote(input.claudeBin)}`,
    `AGENT_COMM_LAUNCH_PROFILE=${shellQuote(input.profile ?? 'auto')}`,
    shellQuote(input.acBin),
    'handle-url',
    '',
  ].join(' ')
  const redirect = ` >> ${shellQuote(input.logPath ?? join(homedir(), '.agent-comm', 'launcher.log'))} 2>&1 &`
  return `on open location theURL
  do shell script ${appleScriptString(bootstrap)} & quoted form of theURL & ${appleScriptString(redirect)}
end open location

on run
  return
end run`
}

export function buildTerminalLauncherScript(command: string, scriptPath: string): string {
  return `#!/bin/zsh
# 删除包含一次性邀请的临时脚本；当前 shell 已经把内容读入。
/bin/rm -f -- ${shellQuote(scriptPath)}
${command}
code=$?
if [ "$code" -ne 0 ]; then
  printf '\\nAgentComm launcher failed (exit %s).\\n' "$code"
  printf 'Details: ~/.agent-comm/launcher.log\\n'
  read -r '?Press Enter to close… '
fi
exit "$code"
`
}

function setPlistValue(plist: string, command: string): void {
  runChecked(PLIST_BUDDY, ['-c', command, plist])
}

export interface InstallMacLauncherOptions {
  appPath?: string | undefined
  profile?: string | undefined
}

/** 安装本机 agentcomm:// URL handler。仅写 ~/Applications 下的可逆 app bundle。 */
export function installMacLauncher(opts: InstallMacLauncherOptions = {}): string {
  if (process.platform !== 'darwin') {
    throw new AgentCommError('NOT_IMPLEMENTED', 'agentcomm:// launcher 目前仅支持 macOS')
  }
  const pluginRoot = findPluginRoot()
  const acBin = join(pluginRoot, 'bin', 'ac')
  const builtMain = join(pluginRoot, 'packages', 'agent-comm', 'dist', 'main.js')
  if (!existsSync(acBin) || !existsSync(builtMain)) {
    throw new AgentCommError('NOT_IMPLEMENTED', '请先在 agent-comm 仓库运行 pnpm build:cli')
  }
  const claudeBin = runChecked('/usr/bin/which', ['claude'])
  if (!claudeBin) throw new AgentCommError('NOT_IMPLEMENTED', '未找到 Claude Code CLI')

  const appPath = opts.appPath ?? join(homedir(), 'Applications', APP_NAME)
  const logPath = join(homedir(), '.agent-comm', 'launcher.log')
  mkdirSync(dirname(appPath), { recursive: true })
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
  rmSync(appPath, { recursive: true, force: true })
  const script = buildLauncherAppleScript({
    acBin,
    claudeBin,
    nodeBin: process.execPath,
    profile: opts.profile,
    logPath,
  })
  runChecked('/usr/bin/osacompile', ['-o', appPath, '-e', script])

  const plist = join(appPath, 'Contents', 'Info.plist')
  // osacompile 生成标准 AppleScript app；在其 plist 上声明 agentcomm URL scheme。
  spawnSync(PLIST_BUDDY, ['-c', 'Delete :CFBundleURLTypes', plist])
  setPlistValue(plist, 'Add :CFBundleURLTypes array')
  setPlistValue(plist, 'Add :CFBundleURLTypes:0 dict')
  setPlistValue(plist, 'Add :CFBundleURLTypes:0:CFBundleURLName string io.agentcomm.launcher')
  setPlistValue(plist, 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array')
  setPlistValue(plist, 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string agentcomm')
  const setUiElement = spawnSync(PLIST_BUDDY, ['-c', 'Set :LSUIElement true', plist])
  if (setUiElement.status !== 0) setPlistValue(plist, 'Add :LSUIElement bool true')
  if (existsSync(LS_REGISTER)) runChecked(LS_REGISTER, ['-f', appPath])
  return appPath
}

/** 由已注册的 URL app 调用：解析邀请并在 Terminal 中启动启用 Channel 的 Claude。 */
export function handleLauncherUrl(rawUrl: string): void {
  if (process.platform !== 'darwin') {
    throw new AgentCommError('NOT_IMPLEMENTED', 'agentcomm:// launcher 目前仅支持 macOS')
  }
  const target = parseLauncherUrl(rawUrl)
  const logPath = join(homedir(), '.agent-comm', 'launcher.log')
  appendFileSync(logPath, `${new Date().toISOString()} opening Claude for ${target.relayUrl}\n`, {
    mode: 0o600,
  })
  const claudeBin = process.env.AGENT_COMM_CLAUDE_BIN
  if (!claudeBin) throw new AgentCommError('NOT_IMPLEMENTED', 'launcher 未记录 Claude Code 路径，请重新安装')
  const command = buildClaudeLaunchCommand({
    ...target,
    claudeBin,
    pluginRoot: findPluginRoot(),
    profile: process.env.AGENT_COMM_LAUNCH_PROFILE,
  })
  const launchDir = join(homedir(), '.agent-comm', 'launchers')
  mkdirSync(launchDir, { recursive: true, mode: 0o700 })
  const scriptPath = join(launchDir, `launch-${Date.now()}-${randomBytes(4).toString('hex')}.command`)
  writeFileSync(scriptPath, buildTerminalLauncherScript(command, scriptPath), { mode: 0o700 })
  chmodSync(scriptPath, 0o700)
  try {
    // `open` 一个本地 .command 文件无需 Terminal Automation / Apple Events 权限。
    runChecked('/usr/bin/open', ['-a', 'Terminal', scriptPath])
    appendFileSync(logPath, `${new Date().toISOString()} Terminal command file opened\n`)
  } catch (err) {
    rmSync(scriptPath, { force: true })
    appendFileSync(logPath, `${new Date().toISOString()} launch failed: ${String(err)}\n`)
    throw err
  }
}
