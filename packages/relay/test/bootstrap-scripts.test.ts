import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderAgentCommLauncher, renderInstallerScript } from '../src/bootstrap-scripts.js'

function makeFakeClaude(dir: string, pluginId = 'agent-comm@agent-comm'): { bin: string; log: string } {
  const bin = join(dir, 'claude')
  const log = join(dir, 'claude.log')
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CLAUDE_LOG"
printf 'runtime=%s\\n' "\${AGENT_COMM_RUNTIME_INSTANCE_ID:-}" >> "$FAKE_CLAUDE_LOG"
if [[ "\${1:-} \${2:-} \${3:-}" == "auth status --json" ]]; then
  printf '{"loggedIn":true}\\n'
elif [[ "\${1:-} \${2:-} \${3:-}" == "plugin list --json" ]]; then
  if [[ -f "$FAKE_PLUGIN_STATE" ]]; then printf '[{"id":"${pluginId}","enabled":true}]\\n'; else printf '[]\\n'; fi
elif [[ "\${1:-} \${2:-} \${3:-}" == "plugin marketplace list" ]]; then
  if [[ -f "\${FAKE_MARKETPLACE_STATE:-$FAKE_PLUGIN_STATE}" ]]; then printf 'agent-comm\\n'; fi
elif [[ "\${1:-} \${2:-}" == "plugin install" ]]; then
  touch "$FAKE_PLUGIN_STATE"
fi
`,
  )
  chmodSync(bin, 0o755)
  return { bin, log }
}

describe('terminal-first bootstrap scripts', () => {
  it('renders shell scripts that pass bash syntax validation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcomm-script-'))
    for (const [name, script] of [
      ['install.sh', renderInstallerScript('https://connect.example.test')],
      ['agentcomm', renderAgentCommLauncher('https://connect.example.test')],
    ] as const) {
      const path = join(dir, name)
      writeFileSync(path, script)
      expect(() => execFileSync('bash', ['-n', path])).not.toThrow()
    }
  })

  it('installs once, reuses the installed version, and starts the community preview Channel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcomm-launch-'))
    const launcher = join(dir, 'agentcomm')
    writeFileSync(launcher, renderAgentCommLauncher('https://connect.example.test'))
    chmodSync(launcher, 0o755)
    const fake = makeFakeClaude(dir)
    const env = {
      ...process.env,
      AGENTCOMM_CLAUDE_BIN: fake.bin,
      CLAUDE_CONFIG_DIR: join(dir, 'claude-profile'),
      FAKE_CLAUDE_LOG: fake.log,
      FAKE_PLUGIN_STATE: join(dir, 'plugin.state'),
      LC_ALL: 'zh_CN.UTF-8',
      LANG: 'zh_CN.UTF-8',
    }
    const invite = 'https://connect.example.test/j/token#k=secret'

    execFileSync(launcher, ['open', invite], { env })
    const first = readFileSync(fake.log, 'utf8')
    expect(first).toContain(
      'plugin marketplace add https://github.com/tianqixinxi/agent-conn.git --scope user',
    )
    expect(first).toContain('plugin install agent-comm@agent-comm --scope user')
    expect(first).toContain('处理这个 AgentComm 邀请')
    expect(first).toContain(invite)
    expect(first).toContain('--dangerously-load-development-channels plugin:agent-comm@agent-comm')
    expect(first).toMatch(/runtime=r-\d+-\d+-\d+/)

    writeFileSync(fake.log, '')
    execFileSync(launcher, ['open', invite], { env })
    const second = readFileSync(fake.log, 'utf8')
    expect(second).not.toContain('plugin marketplace add')
    expect(second).not.toContain('plugin install')
    expect(second).not.toContain('plugin update')
    expect(second).toContain('--dangerously-load-development-channels plugin:agent-comm@agent-comm')
  })

  it('asks one human question and gives share explicit public metadata fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcomm-public-'))
    const launcher = join(dir, 'agentcomm')
    writeFileSync(launcher, renderAgentCommLauncher('https://connect.example.test'))
    chmodSync(launcher, 0o755)
    const fake = makeFakeClaude(dir)
    const env = {
      ...process.env,
      AGENTCOMM_CLAUDE_BIN: fake.bin,
      CLAUDE_CONFIG_DIR: join(dir, 'claude-profile'),
      FAKE_CLAUDE_LOG: fake.log,
      FAKE_PLUGIN_STATE: join(dir, 'plugin.state'),
    }

    execFileSync(launcher, ['create-public', 'https://connect.example.test'], { env })
    const output = readFileSync(fake.log, 'utf8')
    expect(output).toContain('Ask one short, human-friendly question')
    expect(output).toContain('displayName, description, visibility=public, and mode=auto')
    expect(output).toContain('Do not put displayName in alias')
    expect(output).toContain('stable /public/<channelId> observation URL')
  })

  it('uses the allowlisted Channel flag when the official plugin is installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcomm-official-'))
    const launcher = join(dir, 'agentcomm')
    writeFileSync(launcher, renderAgentCommLauncher('https://connect.example.test'))
    chmodSync(launcher, 0o755)
    const fake = makeFakeClaude(dir, 'agent-comm@claude-plugins-official')
    writeFileSync(join(dir, 'plugin.state'), '')
    const env = {
      ...process.env,
      AGENTCOMM_CLAUDE_BIN: fake.bin,
      CLAUDE_CONFIG_DIR: join(dir, 'claude-profile'),
      FAKE_CLAUDE_LOG: fake.log,
      FAKE_PLUGIN_STATE: join(dir, 'plugin.state'),
    }

    execFileSync(launcher, ['open', 'https://connect.example.test/public/general'], { env })
    const output = readFileSync(fake.log, 'utf8')
    expect(output).toContain('--channels plugin:agent-comm@claude-plugins-official')
    expect(output).not.toContain('--dangerously-load-development-channels')
  })

  it('uses the standard Channel flag for an organization-managed allowlist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcomm-managed-'))
    const launcher = join(dir, 'agentcomm')
    writeFileSync(launcher, renderAgentCommLauncher('https://connect.example.test'))
    chmodSync(launcher, 0o755)
    const fake = makeFakeClaude(dir)
    writeFileSync(join(dir, 'plugin.state'), '')
    const env = {
      ...process.env,
      AGENTCOMM_CLAUDE_BIN: fake.bin,
      AGENTCOMM_CHANNEL_POLICY: 'managed',
      CLAUDE_CONFIG_DIR: join(dir, 'claude-profile'),
      FAKE_CLAUDE_LOG: fake.log,
      FAKE_PLUGIN_STATE: join(dir, 'plugin.state'),
    }

    execFileSync(launcher, ['open', 'https://connect.example.test/public/general'], { env })
    const output = readFileSync(fake.log, 'utf8')
    expect(output).toContain('--channels plugin:agent-comm@agent-comm')
    expect(output).not.toContain('--dangerously-load-development-channels')
  })

  it('refreshes a configured marketplace only when a missing plugin must be installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcomm-stale-marketplace-'))
    const launcher = join(dir, 'agentcomm')
    writeFileSync(launcher, renderAgentCommLauncher('https://connect.example.test'))
    chmodSync(launcher, 0o755)
    const fake = makeFakeClaude(dir)
    const marketplaceState = join(dir, 'marketplace.state')
    writeFileSync(marketplaceState, '')
    const env = {
      ...process.env,
      AGENTCOMM_CLAUDE_BIN: fake.bin,
      CLAUDE_CONFIG_DIR: join(dir, 'claude-profile'),
      FAKE_CLAUDE_LOG: fake.log,
      FAKE_PLUGIN_STATE: join(dir, 'plugin.state'),
      FAKE_MARKETPLACE_STATE: marketplaceState,
    }

    execFileSync(launcher, ['open', 'https://connect.example.test/public/general'], { env })
    const output = readFileSync(fake.log, 'utf8')
    expect(output).toContain('plugin marketplace update agent-comm')
    expect(output).not.toContain('plugin marketplace add')
    expect(output).toContain('plugin install agent-comm@agent-comm --scope user')
  })
})
