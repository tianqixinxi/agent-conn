import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { FileApplicationCatalog } from '@agent-comm/application-catalog'
import { ClaudeCodePrintIngressAdapter } from '@agent-comm/harness-claude-code'
import { CodexAppServerIngressAdapter, CodexExecIngressAdapter } from '@agent-comm/harness-codex'
import { ProcessIngressAdapter } from '@agent-comm/ingress-process'
import { isRuntimeIngressOutcomeSource } from '@agent-comm/runtime-ingress'
import {
  FileRuntimeRegistry,
  RuntimeAdapterRegistry,
  type RuntimeRegistration,
  type RuntimeStatus,
  RuntimeSupervisor,
} from '@agent-comm/runtime-supervisor'
import { resolveProfile } from '../config.js'
import { createConfiguredApplicationRegistry } from './applications.js'
import { createIngressRuntime } from './ingress-runtime.js'

export function runtimeRegistryPath(rootDir: string): string {
  return join(rootDir, 'runtimes.json')
}

export function applicationCatalogRoot(rootDir: string): string {
  return join(rootDir, 'applications')
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore', shell: false })
  return result.status === 0
}

export function createDefaultRuntimeAdapterRegistry(): RuntimeAdapterRegistry {
  const registry = new RuntimeAdapterRegistry()
  // Stable non-interactive execution is the default unattended Codex path.
  registry.register({
    id: 'codex-exec',
    harnesses: ['codex-exec'],
    priority: 110,
    detect: () => commandAvailable('codex'),
    create: ({ registration }) =>
      new CodexExecIngressAdapter({ cwd: registration.cwd, command: registration.command }),
  })
  // App Server is available explicitly and remains behind an adapter while its
  // public protocol is experimental.
  registry.register({
    id: 'codex-app-server',
    harnesses: ['codex-app-server'],
    priority: 100,
    detect: () => commandAvailable('codex'),
    create: ({ registration }) => new CodexAppServerIngressAdapter({ cwd: registration.cwd }),
  })
  registry.register({
    id: 'claude-code-print',
    harnesses: ['claude-code'],
    priority: 90,
    detect: () => commandAvailable('claude'),
    create: ({ registration }) =>
      new ClaudeCodePrintIngressAdapter({
        cwd: registration.cwd,
        command: registration.command,
      }),
  })
  registry.register({
    id: 'generic-process',
    harnesses: ['process'],
    priority: 10,
    detect: ({ registration }) => Boolean(registration.command && commandAvailable(registration.command)),
    create: ({ registration }) => {
      if (!registration.command) throw new Error('process runtime requires command')
      return new ProcessIngressAdapter({
        command: registration.command,
        args: registration.args,
        cwd: registration.cwd,
        inheritEnv: true,
      })
    },
  })
  // Auto resolution prefers a stable Codex run, then Claude print mode.
  registry.register({
    id: 'auto-codex-exec',
    harnesses: ['auto'],
    priority: 110,
    detect: () => commandAvailable('codex'),
    create: ({ registration }) => new CodexExecIngressAdapter({ cwd: registration.cwd }),
  })
  registry.register({
    id: 'auto-claude-code',
    harnesses: ['auto'],
    priority: 90,
    detect: () => commandAvailable('claude'),
    create: ({ registration }) => new ClaudeCodePrintIngressAdapter({ cwd: registration.cwd }),
  })
  return registry
}

export function createRuntimeSupervisor(rootDir: string): RuntimeSupervisor {
  const registry = new FileRuntimeRegistry(runtimeRegistryPath(rootDir))
  return new RuntimeSupervisor({
    registry,
    adapters: createDefaultRuntimeAdapterRegistry(),
    launcher: {
      async launch({ registration, adapter, runtimeInstanceId }) {
        const profile = resolveProfile({ profile: registration.profile, rootDir })
        const applicationRegistry = await createConfiguredApplicationRegistry(profile, registration.channels)
        let runtime: Awaited<ReturnType<typeof createIngressRuntime>> | undefined
        if (isRuntimeIngressOutcomeSource(adapter)) {
          adapter.setOutcomeHandler(async (outcome) => {
            if (!runtime) return
            if (await runtime.handleOutcome(outcome)) return
            if (outcome.status === 'completed') {
              await runtime.bridge.reply(outcome.eventId, outcome.result ?? { ok: true })
            } else {
              await runtime.bridge.reply(outcome.eventId, {
                status: 'failed',
                error: outcome.error ?? 'harness failed',
              })
            }
          })
        }
        runtime = await createIngressRuntime(profile, {
          ingress: adapter,
          channels: registration.channels,
          runtimeInstanceId,
          applicationRegistry,
        })
        return runtime
      },
    },
  })
}

export interface RunDaemonOptions {
  rootDir: string
  once?: boolean | undefined
  heartbeatMs?: number | undefined
}

export async function runRuntimeDaemon(options: RunDaemonOptions): Promise<void> {
  const registry = new FileRuntimeRegistry(runtimeRegistryPath(options.rootDir))
  if (registry.registrations().length === 0) {
    throw new Error('no runtimes registered; use agent-comm runtime add first')
  }
  if (!registry.registrations().some((item) => item.trustedAutoResume)) {
    throw new Error(
      'no runtime has trusted auto-resume; repeat runtime add with --trusted-auto-resume after reviewing its channels',
    )
  }
  const supervisor = createRuntimeSupervisor(options.rootDir)
  await supervisor.startAll()
  if (options.once) {
    // The first poll starts immediately, but allow enough time for one remote
    // relay round-trip and one harness completion before shutting adapters down.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await supervisor.stopAll()
    return
  }
  const heartbeat = setInterval(() => supervisor.heartbeat(), options.heartbeatMs ?? 10_000)
  await new Promise<void>((resolvePromise) => {
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      clearInterval(heartbeat)
      void supervisor.stopAll().finally(resolvePromise)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

export function runtimeRegistry(rootDir: string): FileRuntimeRegistry {
  return new FileRuntimeRegistry(runtimeRegistryPath(rootDir))
}

/**
 * Only a fresh heartbeat can authorize signalling a recorded daemon PID.
 * This avoids killing an unrelated process after a stale PID has been reused.
 */
export function stoppableRuntimePids(
  statuses: readonly RuntimeStatus[],
  options: {
    now?: number | undefined
    currentPid?: number | undefined
    freshnessMs?: number | undefined
  } = {},
): number[] {
  const now = options.now ?? Date.now()
  const currentPid = options.currentPid ?? process.pid
  const freshnessMs = options.freshnessMs ?? 30_000
  return [
    ...new Set(
      statuses.flatMap((status) => {
        if (!status.pid || status.pid === currentPid) return []
        const lastSeenAt = Date.parse(status.lastSeenAt)
        if (!Number.isFinite(lastSeenAt) || now - lastSeenAt > freshnessMs) return []
        return [status.pid]
      }),
    ),
  ]
}

export function applicationCatalog(rootDir: string): FileApplicationCatalog {
  return new FileApplicationCatalog(applicationCatalogRoot(rootDir))
}

export function normalizeRuntimeRegistration(
  input: Omit<RuntimeRegistration, 'createdAt' | 'updatedAt'>,
): Omit<RuntimeRegistration, 'createdAt' | 'updatedAt'> {
  return {
    ...input,
    channels: [...new Set(input.channels)],
    applications: [...new Set(input.applications)],
  }
}
