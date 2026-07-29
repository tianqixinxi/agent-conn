import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveProfile } from '../src/config.js'
import { createDefaultRuntimeAdapterRegistry, stoppableRuntimePids } from '../src/runtime/daemon.js'
import {
  installDaemonService,
  renderLaunchdService,
  renderSystemdService,
  uninstallDaemonService,
} from '../src/runtime/service.js'

describe('runtime daemon service', () => {
  it('only signals fresh daemon heartbeats and never the current process', () => {
    const now = Date.parse('2026-07-28T12:00:00.000Z')
    expect(
      stoppableRuntimePids(
        [
          {
            id: 'fresh',
            state: 'online',
            harness: 'codex-exec',
            pid: 101,
            lastSeenAt: '2026-07-28T11:59:50.000Z',
          },
          {
            id: 'duplicate',
            state: 'online',
            harness: 'codex-exec',
            pid: 101,
            lastSeenAt: '2026-07-28T11:59:59.000Z',
          },
          {
            id: 'stale',
            state: 'offline',
            harness: 'claude-code',
            pid: 202,
            lastSeenAt: '2026-07-28T11:00:00.000Z',
          },
          {
            id: 'self',
            state: 'online',
            harness: 'process',
            pid: 303,
            lastSeenAt: '2026-07-28T11:59:59.000Z',
          },
        ],
        { now, currentPid: 303 },
      ),
    ).toEqual([101])
  })

  it('renders explicit profile and root bindings for launchd and systemd', () => {
    const profile = resolveProfile({
      profile: 'worker',
      rootDir: join(tmpdir(), 'agentcomm service root'),
    })
    const input = { profile, nodePath: '/usr/bin/node', cliPath: '/opt/agentcomm/main.js' }
    expect(renderLaunchdService(input)).toContain('<string>worker</string>')
    expect(renderLaunchdService(input)).toContain('<key>AGENT_COMM_ROOT</key>')
    expect(renderSystemdService(input)).toContain('Description=AgentComm Runtime Supervisor')
    expect(renderSystemdService(input)).toContain('AGENT_COMM_ROOT=')
  })

  it('installs and removes a launchd definition without invoking a shell', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentcomm-service-'))
    const cliPath = join(home, 'main.js')
    writeFileSync(cliPath, '')
    const profile = resolveProfile({ profile: 'worker', rootDir: join(home, '.agent-comm') })
    const execute = vi.fn(() => ({ status: 0 }))
    const previousEntry = process.argv[1]
    process.argv[1] = cliPath
    try {
      const installed = installDaemonService({
        profile,
        platform: 'darwin',
        homeDir: home,
        execute,
      })
      expect(installed.started).toBe(true)
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'launchctl', args: expect.arrayContaining(['bootstrap']) }),
      )
      expect(uninstallDaemonService({ platform: 'darwin', homeDir: home, execute }).removed).toBe(true)
    } finally {
      if (previousEntry === undefined) {
        delete process.argv[1]
      } else {
        process.argv[1] = previousEntry
      }
    }
  })

  it('probes an explicitly configured Claude or Codex command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentcomm-custom-runtime-'))
    const command = join(root, 'custom-runtime')
    writeFileSync(command, '#!/bin/sh\nexit 0\n')
    chmodSync(command, 0o700)
    const registry = createDefaultRuntimeAdapterRegistry()
    const registration = {
      id: 'custom',
      profile: 'custom',
      channels: ['c-one'],
      args: [],
      applications: [],
      trustedAutoResume: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await expect(
      registry.resolve({ ...registration, harness: 'codex-exec', command }),
    ).resolves.toMatchObject({ factory: { id: 'codex-exec' } })
    await expect(
      registry.resolve({ ...registration, harness: 'claude-code', command }),
    ).resolves.toMatchObject({ factory: { id: 'claude-code-print' } })
    await expect(
      registry.resolve({
        ...registration,
        harness: 'codex-exec',
        command: join(root, 'missing-runtime'),
      }),
    ).rejects.toThrow('no available harness adapter')
  })
})
