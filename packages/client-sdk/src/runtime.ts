import type {
  ApplicationConsumerRegistry,
  ApplicationEffect,
  ApplicationHarnessOutcome,
  VerifiedApplicationEvent,
} from './index.js'

export type ApplicationTaskState =
  | 'active'
  | 'input-required'
  | 'authorization-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'

export const TERMINAL_APPLICATION_TASK_STATES: ReadonlySet<ApplicationTaskState> = new Set([
  'completed',
  'failed',
  'canceled',
  'rejected',
])

export interface ApplicationStateKey {
  profilePrincipal: string
  channelId: string
  extensionUri: string
  contextId: string
}

export interface ApplicationStateSnapshot extends ApplicationStateKey {
  consumerId: string
  consumerVersion: string
  state: unknown
  taskState: ApplicationTaskState
  lastEventId?: string | undefined
  updatedAt: string
}

export type ApplicationEventStatus = 'reduced' | 'unsupported' | 'ignored-terminal' | 'failed'

export interface StoredApplicationEvent {
  event: VerifiedApplicationEvent
  runtimeInstanceId: string
  status: ApplicationEventStatus
  stale: boolean
  consumerId?: string | undefined
  consumerVersion?: string | undefined
  error?: string | undefined
  recordedAt: string
}

export type ApplicationEffectStatus = 'pending' | 'executing' | 'applied' | 'failed' | 'needs-reconciliation'

export interface JournaledApplicationEffect {
  effectId: string
  messageId: string
  index: number
  effect: ApplicationEffect
  status: ApplicationEffectStatus
  runtimeInstanceId: string
  attempts: number
  lastError?: string | undefined
  updatedAt: string
}

export interface CommitApplicationReductionInput {
  key: ApplicationStateKey
  event: VerifiedApplicationEvent
  runtimeInstanceId: string
  stale: boolean
  consumerId: string
  consumerVersion: string
  state: unknown
  taskState: ApplicationTaskState
  effects: readonly ApplicationEffect[]
  recordedAt: string
}

export interface ApplicationRuntimeStore {
  startRuntime(input: { runtimeInstanceId: string; profilePrincipal: string; startedAt: string }): void
  stopRuntime(runtimeInstanceId: string, stoppedAt: string): void
  getEvent(messageId: string): StoredApplicationEvent | undefined
  getState(key: ApplicationStateKey): ApplicationStateSnapshot | undefined
  commitReduction(input: CommitApplicationReductionInput): {
    duplicate: boolean
    effects: JournaledApplicationEffect[]
  }
  recordEvent(input: StoredApplicationEvent): { duplicate: boolean }
  listEffects(statuses: readonly ApplicationEffectStatus[]): JournaledApplicationEffect[]
  markEffect(
    effectId: string,
    status: ApplicationEffectStatus,
    input: { runtimeInstanceId: string; updatedAt: string; error?: string | undefined },
  ): void
  recoverInterruptedEffects(runtimeInstanceId: string, updatedAt: string): number
  listUnfinished(channelId?: string): ApplicationStateSnapshot[]
}

export interface ApplicationEffectExecutor {
  execute(effect: JournaledApplicationEffect): Promise<void>
}

export interface ApplicationRuntimeOptions {
  runtimeInstanceId: string
  profilePrincipal: string
  registry: ApplicationConsumerRegistry
  store: ApplicationRuntimeStore
  effectExecutor?: ApplicationEffectExecutor | undefined
  now?: (() => Date) | undefined
  staleAfterMs?: number | undefined
}

export type ApplicationProcessResult =
  | {
      status: 'reduced'
      duplicate: boolean
      autoAck: true
      taskState: ApplicationTaskState
      consumerStatus: 'handled' | 'ignored'
      effects: JournaledApplicationEffect[]
    }
  | {
      status: 'unsupported'
      duplicate: boolean
      autoAck: true
      effects: readonly []
    }
  | {
      status: 'ignored-terminal'
      duplicate: boolean
      autoAck: true
      taskState: ApplicationTaskState
      effects: readonly []
    }
  | {
      status: 'failed'
      duplicate: boolean
      autoAck: false
      error: string
      effects: readonly []
    }

function eventContextId(event: VerifiedApplicationEvent): string {
  return event.contextId || event.taskId || event.messageId
}

function eventKey(profilePrincipal: string, event: VerifiedApplicationEvent): ApplicationStateKey {
  return {
    profilePrincipal,
    channelId: event.channelId,
    extensionUri: event.selector.uri,
    contextId: eventContextId(event),
  }
}

function isStale(event: VerifiedApplicationEvent, now: Date, staleAfterMs: number): boolean {
  if (!event.receivedAt) return false
  const received = Date.parse(event.receivedAt)
  return Number.isFinite(received) && now.getTime() - received > staleAfterMs
}

/**
 * Transactional application runtime.
 *
 * Consumer code is required to be pure: it may derive state and return effects,
 * but it cannot execute tools. State + journal commit happens before transport ACK;
 * effects run afterwards under the harness policy.
 */
export class ApplicationRuntime {
  readonly runtimeInstanceId: string
  readonly profilePrincipal: string
  readonly #registry: ApplicationConsumerRegistry
  readonly #store: ApplicationRuntimeStore
  readonly #effectExecutor: ApplicationEffectExecutor | undefined
  readonly #now: () => Date
  readonly #staleAfterMs: number

  constructor(options: ApplicationRuntimeOptions) {
    this.runtimeInstanceId = options.runtimeInstanceId
    this.profilePrincipal = options.profilePrincipal
    this.#registry = options.registry
    this.#store = options.store
    this.#effectExecutor = options.effectExecutor
    this.#now = options.now ?? (() => new Date())
    this.#staleAfterMs = options.staleAfterMs ?? 24 * 60 * 60 * 1_000
    const now = this.#now().toISOString()
    this.#store.startRuntime({
      runtimeInstanceId: this.runtimeInstanceId,
      profilePrincipal: this.profilePrincipal,
      startedAt: now,
    })
    this.#store.recoverInterruptedEffects(this.runtimeInstanceId, now)
  }

  unfinished(channelId?: string): ApplicationStateSnapshot[] {
    return this.#store.listUnfinished(channelId)
  }

  supportedExtensions() {
    return this.#registry.supportedExtensions()
  }

  async process(event: VerifiedApplicationEvent): Promise<ApplicationProcessResult> {
    const now = this.#now()
    const recordedAt = now.toISOString()
    const stale = isStale(event, now, this.#staleAfterMs)
    const existing = this.#store.getEvent(event.messageId)
    if (existing) {
      const state = this.#store.getState(eventKey(this.profilePrincipal, event))
      if (existing.status === 'unsupported') {
        return { status: 'unsupported', duplicate: true, autoAck: true, effects: [] }
      }
      if (existing.status === 'ignored-terminal') {
        return {
          status: 'ignored-terminal',
          duplicate: true,
          autoAck: true,
          taskState: state?.taskState ?? 'completed',
          effects: [],
        }
      }
      if (existing.status === 'failed') {
        return {
          status: 'failed',
          duplicate: true,
          autoAck: false,
          error: existing.error ?? 'application reducer failed',
          effects: [],
        }
      }
      return {
        status: 'reduced',
        duplicate: true,
        autoAck: true,
        taskState: state?.taskState ?? 'active',
        consumerStatus: 'handled',
        effects: [],
      }
    }
    const resolved = this.#registry.resolve(event.selector, event.channelId)
    if (!resolved) {
      const { duplicate } = this.#store.recordEvent({
        event,
        runtimeInstanceId: this.runtimeInstanceId,
        status: 'unsupported',
        stale,
        recordedAt,
      })
      return { status: 'unsupported', duplicate, autoAck: true, effects: [] }
    }

    const key = eventKey(this.profilePrincipal, event)
    const current = this.#store.getState(key)
    if (current && TERMINAL_APPLICATION_TASK_STATES.has(current.taskState)) {
      const { duplicate } = this.#store.recordEvent({
        event,
        runtimeInstanceId: this.runtimeInstanceId,
        status: 'ignored-terminal',
        stale,
        consumerId: resolved.consumer.id,
        consumerVersion: resolved.consumer.version ?? '0.0.0',
        recordedAt,
      })
      return {
        status: 'ignored-terminal',
        duplicate,
        autoAck: true,
        taskState: current.taskState,
        effects: [],
      }
    }

    try {
      const result = await resolved.consumer.handle(event, {
        runtimeId: this.runtimeInstanceId,
        profilePrincipal: this.profilePrincipal,
        channelId: event.channelId,
        extensionUri: event.selector.uri,
        contextId: key.contextId,
        state: current?.state,
        taskState: current?.taskState ?? 'active',
        stale,
      })
      const taskState = result.taskState ?? current?.taskState ?? 'active'
      const committed = this.#store.commitReduction({
        key,
        event,
        runtimeInstanceId: this.runtimeInstanceId,
        stale,
        consumerId: resolved.consumer.id,
        consumerVersion: resolved.consumer.version ?? '0.0.0',
        state: Object.hasOwn(result, 'state') ? result.state : current?.state,
        taskState,
        effects: result.effects,
        recordedAt,
      })
      return {
        status: 'reduced',
        duplicate: committed.duplicate,
        autoAck: true,
        taskState,
        consumerStatus: result.status,
        effects: committed.effects,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const { duplicate } = this.#store.recordEvent({
        event,
        runtimeInstanceId: this.runtimeInstanceId,
        status: 'failed',
        stale,
        consumerId: resolved.consumer.id,
        consumerVersion: resolved.consumer.version ?? '0.0.0',
        error: message,
        recordedAt,
      })
      return { status: 'failed', duplicate, autoAck: false, error: message, effects: [] }
    }
  }

  async resume(
    messageId: string,
    outcome: ApplicationHarnessOutcome,
  ): Promise<ApplicationProcessResult | undefined> {
    const stored = this.#store.getEvent(messageId)
    if (stored?.status !== 'reduced') return undefined
    const source = stored.event
    const resolved = this.#registry.resolve(source.selector, source.channelId)
    if (!resolved?.consumer.resume) return undefined
    const key = eventKey(this.profilePrincipal, source)
    const current = this.#store.getState(key)
    if (!current || TERMINAL_APPLICATION_TASK_STATES.has(current.taskState)) return undefined
    const outcomeEvent: VerifiedApplicationEvent = {
      ...source,
      messageId: `${messageId}:harness-outcome`,
      from: this.profilePrincipal,
      body: outcome,
      receivedAt: this.#now().toISOString(),
      sourceRuntimeInstanceId: this.runtimeInstanceId,
    }
    const existing = this.#store.getEvent(outcomeEvent.messageId)
    if (existing) {
      return {
        status: 'reduced',
        duplicate: true,
        autoAck: true,
        taskState: this.#store.getState(key)?.taskState ?? current.taskState,
        consumerStatus: 'handled',
        effects: [],
      }
    }
    try {
      const result = await resolved.consumer.resume(source, outcome, {
        runtimeId: this.runtimeInstanceId,
        profilePrincipal: this.profilePrincipal,
        channelId: source.channelId,
        extensionUri: source.selector.uri,
        contextId: key.contextId,
        state: current.state,
        taskState: current.taskState,
        stale: false,
      })
      const recordedAt = this.#now().toISOString()
      const taskState = result.taskState ?? current.taskState
      const committed = this.#store.commitReduction({
        key,
        event: outcomeEvent,
        runtimeInstanceId: this.runtimeInstanceId,
        stale: false,
        consumerId: resolved.consumer.id,
        consumerVersion: resolved.consumer.version ?? '0.0.0',
        state: Object.hasOwn(result, 'state') ? result.state : current.state,
        taskState,
        effects: result.effects,
        recordedAt,
      })
      for (const effect of this.#store.listEffects(['pending'])) {
        if (effect.messageId !== messageId || effect.effect.type !== 'request-input') continue
        this.#store.markEffect(effect.effectId, 'applied', {
          runtimeInstanceId: this.runtimeInstanceId,
          updatedAt: recordedAt,
        })
      }
      return {
        status: 'reduced',
        duplicate: committed.duplicate,
        autoAck: true,
        taskState,
        consumerStatus: result.status,
        effects: committed.effects,
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const { duplicate } = this.#store.recordEvent({
        event: outcomeEvent,
        runtimeInstanceId: this.runtimeInstanceId,
        status: 'failed',
        stale: false,
        consumerId: resolved.consumer.id,
        consumerVersion: resolved.consumer.version ?? '0.0.0',
        error: detail,
        recordedAt: this.#now().toISOString(),
      })
      return { status: 'failed', duplicate, autoAck: false, error: detail, effects: [] }
    }
  }

  async executePendingEffects(
    canExecute: (effect: JournaledApplicationEffect) => boolean = () => true,
  ): Promise<JournaledApplicationEffect[]> {
    if (!this.#effectExecutor) return []
    const processed: JournaledApplicationEffect[] = []
    for (const effect of this.#store.listEffects(['pending'])) {
      if (!canExecute(effect)) continue
      const startedAt = this.#now().toISOString()
      this.#store.markEffect(effect.effectId, 'executing', {
        runtimeInstanceId: this.runtimeInstanceId,
        updatedAt: startedAt,
      })
      try {
        await this.#effectExecutor.execute(effect)
        this.#store.markEffect(effect.effectId, 'applied', {
          runtimeInstanceId: this.runtimeInstanceId,
          updatedAt: this.#now().toISOString(),
        })
        processed.push({ ...effect, status: 'applied', runtimeInstanceId: this.runtimeInstanceId })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.#store.markEffect(effect.effectId, 'failed', {
          runtimeInstanceId: this.runtimeInstanceId,
          updatedAt: this.#now().toISOString(),
          error: message,
        })
        processed.push({
          ...effect,
          status: 'failed',
          runtimeInstanceId: this.runtimeInstanceId,
          lastError: message,
        })
      }
    }
    return processed
  }

  close(): void {
    this.#store.stopRuntime(this.runtimeInstanceId, this.#now().toISOString())
  }
}

function stateKeyString(key: ApplicationStateKey): string {
  return [key.profilePrincipal, key.channelId, key.extensionUri, key.contextId].join('\u0000')
}

/** Deterministic in-memory implementation for application tests and embedders. */
export class InMemoryApplicationRuntimeStore implements ApplicationRuntimeStore {
  readonly runtimes = new Map<
    string,
    { profilePrincipal: string; startedAt: string; stoppedAt?: string | undefined }
  >()
  readonly states = new Map<string, ApplicationStateSnapshot>()
  readonly events = new Map<string, StoredApplicationEvent>()
  readonly effects = new Map<string, JournaledApplicationEffect>()

  startRuntime(input: { runtimeInstanceId: string; profilePrincipal: string; startedAt: string }): void {
    this.runtimes.set(input.runtimeInstanceId, {
      profilePrincipal: input.profilePrincipal,
      startedAt: input.startedAt,
    })
  }

  stopRuntime(runtimeInstanceId: string, stoppedAt: string): void {
    const current = this.runtimes.get(runtimeInstanceId)
    if (current) this.runtimes.set(runtimeInstanceId, { ...current, stoppedAt })
  }

  getEvent(messageId: string): StoredApplicationEvent | undefined {
    return this.events.get(messageId)
  }

  getState(key: ApplicationStateKey): ApplicationStateSnapshot | undefined {
    return this.states.get(stateKeyString(key))
  }

  commitReduction(input: CommitApplicationReductionInput): {
    duplicate: boolean
    effects: JournaledApplicationEffect[]
  } {
    if (this.events.has(input.event.messageId)) return { duplicate: true, effects: [] }
    this.events.set(input.event.messageId, {
      event: input.event,
      runtimeInstanceId: input.runtimeInstanceId,
      status: 'reduced',
      stale: input.stale,
      consumerId: input.consumerId,
      consumerVersion: input.consumerVersion,
      recordedAt: input.recordedAt,
    })
    this.states.set(stateKeyString(input.key), {
      ...input.key,
      consumerId: input.consumerId,
      consumerVersion: input.consumerVersion,
      state: input.state,
      taskState: input.taskState,
      lastEventId: input.event.messageId,
      updatedAt: input.recordedAt,
    })
    const effects = input.effects.map((effect, index) => {
      const item: JournaledApplicationEffect = {
        effectId: `effect:${input.event.messageId}:${index}`,
        messageId: input.event.messageId,
        index,
        effect,
        status: 'pending',
        runtimeInstanceId: input.runtimeInstanceId,
        attempts: 0,
        updatedAt: input.recordedAt,
      }
      this.effects.set(item.effectId, item)
      return item
    })
    return { duplicate: false, effects }
  }

  recordEvent(input: StoredApplicationEvent): { duplicate: boolean } {
    if (this.events.has(input.event.messageId)) return { duplicate: true }
    this.events.set(input.event.messageId, input)
    return { duplicate: false }
  }

  listEffects(statuses: readonly ApplicationEffectStatus[]): JournaledApplicationEffect[] {
    const accepted = new Set(statuses)
    return [...this.effects.values()]
      .filter((effect) => accepted.has(effect.status))
      .sort((a, b) => a.effectId.localeCompare(b.effectId))
  }

  markEffect(
    effectId: string,
    status: ApplicationEffectStatus,
    input: { runtimeInstanceId: string; updatedAt: string; error?: string | undefined },
  ): void {
    const current = this.effects.get(effectId)
    if (!current) throw new Error(`application effect not found: ${effectId}`)
    this.effects.set(effectId, {
      ...current,
      status,
      runtimeInstanceId: input.runtimeInstanceId,
      attempts: status === 'executing' ? current.attempts + 1 : current.attempts,
      updatedAt: input.updatedAt,
      ...(input.error === undefined ? {} : { lastError: input.error }),
    })
  }

  recoverInterruptedEffects(runtimeInstanceId: string, updatedAt: string): number {
    let recovered = 0
    for (const [id, effect] of this.effects) {
      if (effect.status !== 'executing' || effect.runtimeInstanceId === runtimeInstanceId) continue
      this.effects.set(id, { ...effect, status: 'needs-reconciliation', updatedAt })
      recovered += 1
    }
    return recovered
  }

  listUnfinished(channelId?: string): ApplicationStateSnapshot[] {
    return [...this.states.values()].filter(
      (state) =>
        (channelId === undefined || state.channelId === channelId) &&
        !TERMINAL_APPLICATION_TASK_STATES.has(state.taskState),
    )
  }
}
