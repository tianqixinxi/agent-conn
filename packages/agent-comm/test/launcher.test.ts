import { describe, expect, it } from 'vitest'
import {
  buildClaudeLaunchCommand,
  buildLauncherAppleScript,
  buildTerminalLauncherScript,
  parseLauncherUrl,
} from '../src/launcher/macos.js'

describe('macOS browser launcher', () => {
  const key = Buffer.alloc(32, 9).toString('base64url')
  const invite = `https://relay.example/j/tok_123#k=${key}`

  it('recovers the complete invitation including its browser-only E2E fragment', () => {
    const launcherUrl = `agentcomm://open?invite=${encodeURIComponent(invite)}`
    expect(parseLauncherUrl(launcherUrl)).toEqual({ invite, relayUrl: 'https://relay.example' })
  })

  it('builds a Claude session with the AgentComm channel enabled and no shell interpolation', () => {
    const command = buildClaudeLaunchCommand({
      invite,
      relayUrl: 'https://relay.example',
      claudeBin: '/Users/me/bin/claude',
      pluginRoot: '/tmp/plugin with spaces',
      profile: 'bob',
    })
    expect(command).toContain("AGENT_COMM_CHANNEL_PROFILE='bob'")
    expect(command).toContain("AGENT_COMM_CHANNEL_ALIAS='bob'")
    expect(command).toContain("AGENT_COMM_RELAY_URL='https://relay.example'")
    expect(command).toContain("CLAUDE_PLUGIN_ROOT='/tmp/plugin with spaces'")
    expect(command).toContain("'/Users/me/bin/claude'")
    expect(command).toContain("--plugin-dir '/tmp/plugin with spaces'")
    expect(command).toContain('--dangerously-load-development-channels server:agent-comm')
    expect(command).toContain('host-enforced yes/no permission')
    expect(command).toContain(invite)
    expect(command.indexOf('This session was opened')).toBeLessThan(
      command.indexOf('--dangerously-load-development-channels'),
    )
  })

  it('uses Claude session identity by default instead of reusing a machine profile', () => {
    const command = buildClaudeLaunchCommand({
      invite,
      relayUrl: 'https://relay.example',
      claudeBin: '/tmp/claude',
      pluginRoot: '/tmp/plugin',
      profile: 'auto',
    })
    expect(command).not.toContain('AGENT_COMM_CHANNEL_PROFILE=')
    expect(command).not.toContain('AGENT_COMM_CHANNEL_ALIAS=')
    expect(command).toContain('Starting AgentComm + Claude Code')
  })

  it('installs an AppleScript open-location handler that delegates to the bundled CLI', () => {
    const script = buildLauncherAppleScript({
      acBin: '/tmp/agent comm/bin/ac',
      claudeBin: '/tmp/claude',
      nodeBin: '/tmp/node',
      profile: 'bob',
    })
    expect(script).toContain('on open location theURL')
    expect(script).toContain('quoted form of theURL')
    expect(script).toContain('handle-url')
    expect(script).toContain('AGENT_COMM_CLAUDE_BIN')
    expect(script).toContain("AGENT_COMM_LAUNCH_PROFILE='bob'")
    expect(script).toContain('launcher.log')
  })

  it('builds a self-deleting Terminal command file with visible failure diagnostics', () => {
    const script = buildTerminalLauncherScript('run-claude --flag', '/tmp/agent launch.command')
    expect(script).toContain("/bin/rm -f -- '/tmp/agent launch.command'")
    expect(script).toContain('run-claude --flag')
    expect(script).toContain('AgentComm launcher failed')
    expect(script).toContain('launcher.log')
  })
})
