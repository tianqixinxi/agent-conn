import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type {
  RuntimeIngressAdapter,
  RuntimeIngressContext,
  RuntimeIngressDeliveryResult,
  RuntimeIngressEvent,
} from '@agent-comm/runtime-ingress'
import { z } from 'zod'

export const RuntimeHarnessSchema = z.enum([
  'auto',
  'claude-code',
  'codex-app-server',
  'codex-exec',
  'process',
])
export type RuntimeHarness = z.infer<typeof RuntimeHarnessSchema>

export const RuntimeRegistrationSchema = z.object({
  id: z.string().min(1),
  profile: z.string().min(1),
  harness: RuntimeHarnessSchema.default('auto'),
  channels: z.array(z.string().min(1)).min(1),
  cwd: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  applications: z.array(z.string()).default([]),
  trustedAutoResume: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export type RuntimeRegistration = z.infer<typeof RuntimeRegistrationSchema>

export const RuntimeStatusSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['registered', 'starting', 'online', 'degraded', 'offline', 'failed']),
  harness: RuntimeHarnessSchema,
  adapterId: z.string().optional(),
  pid: z.number().int().positive().optional(),
  runtimeInstanceId: z.string().optional(),
  lastSeenAt: z.string().datetime(),
  detail: z.string().optional(),
})

export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>

const RuntimeRegistryStateSchema = z.object({
  schemaVersion: z.literal(1),
  registrations: z.array(RuntimeRegistrationSchema).default([]),
  statuses: z.array(RuntimeStatusSchema).default([]),
})

function atomicWrite(path: string, value: unknown): void {
  // FileRuntimeRegistry resolves a local operator-owned registry path before this helper is used.
  // Runtime registrations are serialized as data and cannot influence this path.
  // codeql[js/path-injection]
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  // codeql[js/path-injection]
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  // codeql[js/path-injection]
  renameSync(temporary, path)
}

export class FileRuntimeRegistry {
  readonly path: string

  constructor(path: string) {
    this.path = resolve(path)
  }

  #read(): z.infer<typeof RuntimeRegistryStateSchema> {
    // this.path is a resolved local configuration path, never a channel event or remote message.
    // codeql[js/path-injection]
    if (!existsSync(this.path)) {
      return { schemaVersion: 1, registrations: [], statuses: [] }
    }
    // codeql[js/path-injection]
    return RuntimeRegistryStateSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
  }

  #write(state: z.infer<typeof RuntimeRegistryStateSchema>): void {
    atomicWrite(this.path, RuntimeRegistryStateSchema.parse(state))
  }

  registrations(): RuntimeRegistration[] {
    return this.#read().registrations
  }

  statuses(): RuntimeStatus[] {
    return this.#read().statuses
  }

  register(
    input: Omit<RuntimeRegistration, 'createdAt' | 'updatedAt'> &
      Partial<Pick<RuntimeRegistration, 'createdAt' | 'updatedAt'>>,
  ): RuntimeRegistration {
    const state = this.#read()
    const previous = state.registrations.find((item) => item.id === input.id)
    const now = new Date().toISOString()
    const registration = RuntimeRegistrationSchema.parse({
      ...input,
      createdAt: previous?.createdAt ?? input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    })
    state.registrations = state.registrations.filter((item) => item.id !== registration.id)
    state.registrations.push(registration)
    this.#write(state)
    return registration
  }

  remove(id: string): boolean {
    const state = this.#read()
    const before = state.registrations.length
    state.registrations = state.registrations.filter((item) => item.id !== id)
    state.statuses = state.statuses.filter((item) => item.id !== id)
    if (state.registrations.length === before) return false
    this.#write(state)
    return true
  }

  updateStatus(status: RuntimeStatus): void {
    const state = this.#read()
    const parsed = RuntimeStatusSchema.parse(status)
    state.statuses = state.statuses.filter((item) => item.id !== parsed.id)
    state.statuses.push(parsed)
    this.#write(state)
  }
}

export interface RuntimeAdapterFactoryContext {
  registration: RuntimeRegistration
}

export interface RuntimeAdapterFactory {
  id: string
  harnesses: readonly RuntimeHarness[]
  priority: number
  detect(context: RuntimeAdapterFactoryContext): Promise<boolean> | boolean
  create(context: RuntimeAdapterFactoryContext): Promise<RuntimeIngressAdapter> | RuntimeIngressAdapter
}

export class RuntimeAdapterRegistry {
  readonly #factories: RuntimeAdapterFactory[] = []

  register(factory: RuntimeAdapterFactory): () => void {
    this.#factories.push(factory)
    return () => {
      const index = this.#factories.indexOf(factory)
      if (index >= 0) this.#factories.splice(index, 1)
    }
  }

  async resolve(registration: RuntimeRegistration): Promise<{
    factory: RuntimeAdapterFactory
    adapter: RuntimeIngressAdapter
  }> {
    const candidates = [...this.#factories]
      .filter(
        (factory) => registration.harness === 'auto' || factory.harnesses.includes(registration.harness),
      )
      .sort((a, b) => b.priority - a.priority)
    for (const factory of candidates) {
      if (!(await factory.detect({ registration }))) continue
      return { factory, adapter: await factory.create({ registration }) }
    }
    throw new Error(`no available harness adapter for ${registration.harness}`)
  }
}

export interface SupervisedRuntime {
  runtimeInstanceId: string
  close(): Promise<void>
}

export interface RuntimeLauncher {
  launch(input: {
    registration: RuntimeRegistration
    adapter: RuntimeIngressAdapter
    runtimeInstanceId: string
  }): Promise<SupervisedRuntime>
}

interface ActiveRuntime {
  registration: RuntimeRegistration
  adapter: RuntimeIngressAdapter
  runtime: SupervisedRuntime
}

export class RuntimeSupervisor {
  readonly #registry: FileRuntimeRegistry
  readonly #adapters: RuntimeAdapterRegistry
  readonly #launcher: RuntimeLauncher
  readonly #active = new Map<string, ActiveRuntime>()

  constructor(options: {
    registry: FileRuntimeRegistry
    adapters: RuntimeAdapterRegistry
    launcher: RuntimeLauncher
  }) {
    this.#registry = options.registry
    this.#adapters = options.adapters
    this.#launcher = options.launcher
  }

  async start(registration: RuntimeRegistration): Promise<RuntimeStatus> {
    if (this.#active.has(registration.id)) return this.status(registration.id)
    const now = new Date().toISOString()
    this.#registry.updateStatus({
      id: registration.id,
      state: 'starting',
      harness: registration.harness,
      pid: process.pid,
      lastSeenAt: now,
    })
    try {
      const resolved = await this.#adapters.resolve(registration)
      const runtimeInstanceId = `r-${randomUUID().replaceAll('-', '')}`
      const runtime = await this.#launcher.launch({
        registration,
        adapter: resolved.adapter,
        runtimeInstanceId,
      })
      this.#active.set(registration.id, {
        registration,
        adapter: resolved.adapter,
        runtime,
      })
      const status: RuntimeStatus = {
        id: registration.id,
        state: 'online',
        harness: registration.harness,
        adapterId: resolved.adapter.id,
        pid: process.pid,
        runtimeInstanceId: runtime.runtimeInstanceId,
        lastSeenAt: new Date().toISOString(),
      }
      this.#registry.updateStatus(status)
      return status
    } catch (error) {
      const status: RuntimeStatus = {
        id: registration.id,
        state: 'failed',
        harness: registration.harness,
        pid: process.pid,
        lastSeenAt: new Date().toISOString(),
        detail: error instanceof Error ? error.message : String(error),
      }
      this.#registry.updateStatus(status)
      throw error
    }
  }

  async startAll(): Promise<RuntimeStatus[]> {
    const statuses: RuntimeStatus[] = []
    for (const registration of this.#registry.registrations().filter((item) => item.trustedAutoResume)) {
      statuses.push(await this.start(registration))
    }
    return statuses
  }

  heartbeat(): void {
    for (const [id, active] of this.#active) {
      this.#registry.updateStatus({
        id,
        state: 'online',
        harness: active.registration.harness,
        adapterId: active.adapter.id,
        pid: process.pid,
        runtimeInstanceId: active.runtime.runtimeInstanceId,
        lastSeenAt: new Date().toISOString(),
      })
    }
  }

  status(id: string): RuntimeStatus {
    const found = this.#registry.statuses().find((item) => item.id === id)
    if (!found) throw new Error(`runtime status not found: ${id}`)
    return found
  }

  async stop(id: string): Promise<void> {
    const active = this.#active.get(id)
    if (active) {
      await active.runtime.close()
      this.#active.delete(id)
    }
    const registration = this.#registry.registrations().find((item) => item.id === id)
    this.#registry.updateStatus({
      id,
      state: 'offline',
      harness: registration?.harness ?? 'auto',
      lastSeenAt: new Date().toISOString(),
    })
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.#active.keys()]) await this.stop(id)
  }
}

export interface NativeFirstAdapter {
  adapter: RuntimeIngressAdapter
  proximity: 'native' | 'local' | 'remote'
  priority?: number | undefined
}

const proximityScore = { native: 3_000, local: 2_000, remote: 1_000 } as const

/**
 * Chooses the cheapest available ingress without exposing transport selection to
 * the application protocol. Unsupported adapters fall through; ambiguous
 * deferred deliveries remain sticky to avoid duplicate harness turns.
 */
export class NativeFirstIngressRouter implements RuntimeIngressAdapter {
  readonly id = 'native-first-ingress-router'
  readonly capabilities
  readonly #entries: NativeFirstAdapter[]
  readonly #context = new Map<string, RuntimeIngressContext>()

  constructor(entries: readonly NativeFirstAdapter[]) {
    if (entries.length === 0) throw new Error('at least one ingress adapter is required')
    this.#entries = [...entries].sort(
      (a, b) =>
        proximityScore[b.proximity] + (b.priority ?? 0) - (proximityScore[a.proximity] + (a.priority ?? 0)),
    )
    const first = this.#entries[0]?.adapter
    if (!first) throw new Error('at least one ingress adapter is required')
    this.capabilities = {
      ...first.capabilities,
      background: this.#entries.some((entry) => entry.adapter.capabilities.background),
      interactiveApproval: this.#entries.some((entry) => entry.adapter.capabilities.interactiveApproval),
      streaming: this.#entries.some((entry) => entry.adapter.capabilities.streaming),
    }
  }

  async start(context: RuntimeIngressContext): Promise<void> {
    for (const entry of this.#entries) {
      this.#context.set(entry.adapter.id, context)
      await entry.adapter.start?.(context)
    }
  }

  async deliver(event: RuntimeIngressEvent): Promise<RuntimeIngressDeliveryResult> {
    for (const entry of this.#entries) {
      const result = await entry.adapter.deliver(event)
      if (result.status === 'unsupported') continue
      return result
    }
    return { status: 'unsupported', detail: 'no native, local, or remote adapter supports this event' }
  }

  async stop(): Promise<void> {
    for (const entry of [...this.#entries].reverse()) await entry.adapter.stop?.()
    this.#context.clear()
  }
}
