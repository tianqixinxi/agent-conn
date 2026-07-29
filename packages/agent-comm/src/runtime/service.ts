import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ProfilePaths } from '../config.js'

export type ServicePlatform = 'darwin' | 'linux'

export interface DaemonServiceCommand {
  command: string
  args: readonly string[]
}

export type DaemonServiceExecutor = (command: DaemonServiceCommand) => {
  status: number | null
  stderr?: string | undefined
}

function defaultExecutor(input: DaemonServiceCommand): {
  status: number | null
  stderr?: string | undefined
} {
  const result = spawnSync(input.command, input.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: false,
  })
  return { status: result.status, stderr: result.stderr }
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function cliArguments(cliPath: string): string[] {
  return cliPath.endsWith('.ts') ? ['--import', 'tsx', cliPath] : [cliPath]
}

export function renderLaunchdService(input: {
  profile: ProfilePaths
  nodePath: string
  cliPath: string
}): string {
  const argumentsList = [
    input.nodePath,
    ...cliArguments(input.cliPath),
    '--profile',
    input.profile.name,
    'daemon',
    'run',
  ]
  const array = argumentsList.map((value) => `      <string>${xml(value)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>dev.agentcomm.runtime</string>
    <key>ProgramArguments</key>
    <array>
${array}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>AGENT_COMM_ROOT</key>
      <string>${xml(input.profile.rootDir)}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xml(join(input.profile.rootDir, 'daemon.out.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(join(input.profile.rootDir, 'daemon.err.log'))}</string>
  </dict>
</plist>
`
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
}

export function renderSystemdService(input: {
  profile: ProfilePaths
  nodePath: string
  cliPath: string
}): string {
  const command = [
    input.nodePath,
    ...cliArguments(input.cliPath),
    '--profile',
    input.profile.name,
    'daemon',
    'run',
  ]
    .map(systemdQuote)
    .join(' ')
  return `[Unit]
Description=AgentComm Runtime Supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=${systemdQuote(`AGENT_COMM_ROOT=${input.profile.rootDir}`)}
ExecStart=${command}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

export interface InstallDaemonServiceOptions {
  profile: ProfilePaths
  platform?: NodeJS.Platform | undefined
  start?: boolean | undefined
  execute?: DaemonServiceExecutor | undefined
}

export function installDaemonService(options: InstallDaemonServiceOptions): {
  platform: ServicePlatform
  path: string
  started: boolean
} {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`daemon service installation is not supported on ${platform}`)
  }
  const cliPath = resolve(process.argv[1] ?? '')
  const nodePath = resolve(process.execPath)
  const home = resolve(homedir())
  const execute = options.execute ?? defaultExecutor
  const start = options.start ?? true
  let path: string
  let content: string
  if (platform === 'darwin') {
    path = join(home, 'Library', 'LaunchAgents', 'dev.agentcomm.runtime.plist')
    content = renderLaunchdService({ profile: options.profile, nodePath, cliPath })
  } else {
    path = join(home, '.config', 'systemd', 'user', 'agentcomm.service')
    content = renderSystemdService({ profile: options.profile, nodePath, cliPath })
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // path is a fixed suffix below the resolved local home directory.
  // codeql[js/path-injection]
  writeFileSync(path, content, { mode: 0o600 })
  if (!start) return { platform, path, started: false }
  const commands: DaemonServiceCommand[] =
    platform === 'darwin'
      ? [
          {
            command: 'launchctl',
            args: ['bootout', `gui/${process.getuid?.() ?? 0}`, path],
          },
          {
            command: 'launchctl',
            args: ['bootstrap', `gui/${process.getuid?.() ?? 0}`, path],
          },
        ]
      : [
          { command: 'systemctl', args: ['--user', 'daemon-reload'] },
          { command: 'systemctl', args: ['--user', 'enable', '--now', 'agentcomm.service'] },
        ]
  for (const command of commands) {
    const result = execute(command)
    if (platform === 'darwin' && command.args[0] === 'bootout') continue
    if (result.status !== 0) {
      throw new Error(
        `${command.command} failed: ${result.stderr?.trim() || `exit ${result.status ?? 'unknown'}`}`,
      )
    }
  }
  return { platform, path, started: true }
}

export function uninstallDaemonService(
  options: { platform?: NodeJS.Platform | undefined; execute?: DaemonServiceExecutor | undefined } = {},
): { removed: boolean; path: string } {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`daemon service installation is not supported on ${platform}`)
  }
  const home = resolve(homedir())
  const execute = options.execute ?? defaultExecutor
  const path =
    platform === 'darwin'
      ? join(home, 'Library', 'LaunchAgents', 'dev.agentcomm.runtime.plist')
      : join(home, '.config', 'systemd', 'user', 'agentcomm.service')
  if (platform === 'darwin') {
    execute({
      command: 'launchctl',
      args: ['bootout', `gui/${process.getuid?.() ?? 0}`, path],
    })
  } else {
    execute({ command: 'systemctl', args: ['--user', 'disable', '--now', 'agentcomm.service'] })
    execute({ command: 'systemctl', args: ['--user', 'daemon-reload'] })
  }
  const removed = existsSync(path)
  // path is a fixed suffix below the resolved local home directory.
  // codeql[js/path-injection]
  rmSync(path, { force: true })
  return { removed, path }
}
