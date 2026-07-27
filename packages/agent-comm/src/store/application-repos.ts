import type { DatabaseSync } from 'node:sqlite'
import type {
  ApplicationEffectStatus,
  ApplicationRuntimeStore,
  ApplicationStateKey,
  ApplicationStateSnapshot,
  CommitApplicationReductionInput,
  JournaledApplicationEffect,
  StoredApplicationEvent,
} from '@agent-comm/client-sdk'
import type { AuthorizationReceipt, TaskAuthorization } from '@agent-comm/core'
import { AgentCommError } from '@agent-comm/core'
import { optStr, parseJson, type Row, reqBool, reqNum, reqStr, toJson, withTx } from './sqlite.js'

function toStoredEvent(row: Row): StoredApplicationEvent {
  return {
    event: parseJson(reqStr(row, 'event_json')),
    runtimeInstanceId: reqStr(row, 'processing_runtime_instance_id'),
    status: reqStr(row, 'status') as StoredApplicationEvent['status'],
    stale: reqBool(row, 'stale'),
    consumerId: optStr(row, 'consumer_id'),
    consumerVersion: optStr(row, 'consumer_version'),
    error: optStr(row, 'error'),
    recordedAt: reqStr(row, 'recorded_at'),
  }
}

function toState(row: Row): ApplicationStateSnapshot {
  return {
    profilePrincipal: reqStr(row, 'profile_principal'),
    channelId: reqStr(row, 'channel_id'),
    extensionUri: reqStr(row, 'extension_uri'),
    contextId: reqStr(row, 'context_id'),
    consumerId: reqStr(row, 'consumer_id'),
    consumerVersion: reqStr(row, 'consumer_version'),
    state: parseJson(reqStr(row, 'state_json')),
    taskState: reqStr(row, 'task_state') as ApplicationStateSnapshot['taskState'],
    lastEventId: optStr(row, 'last_event_id'),
    updatedAt: reqStr(row, 'updated_at'),
  }
}

function toEffect(row: Row): JournaledApplicationEffect {
  return {
    effectId: reqStr(row, 'effect_id'),
    messageId: reqStr(row, 'message_id'),
    index: reqNum(row, 'effect_index'),
    effect: parseJson(reqStr(row, 'effect_json')),
    status: reqStr(row, 'status') as ApplicationEffectStatus,
    runtimeInstanceId: reqStr(row, 'runtime_instance_id'),
    attempts: reqNum(row, 'attempts'),
    lastError: optStr(row, 'last_error'),
    updatedAt: reqStr(row, 'updated_at'),
  }
}

function insertEvent(db: DatabaseSync, input: StoredApplicationEvent): boolean {
  const event = input.event
  const result = db
    .prepare(`
      INSERT INTO application_events (
        message_id, channel_id, extension_uri, extension_version, event_type, context_id, task_id,
        from_alias, event_json, source_runtime_instance_id, processing_runtime_instance_id, status,
        stale, consumer_id, consumer_version, error, original_ts, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO NOTHING
    `)
    .run(
      event.messageId,
      event.channelId,
      event.selector.uri,
      event.selector.version,
      event.selector.eventType,
      event.contextId ?? null,
      event.taskId ?? null,
      event.from,
      toJson(event),
      event.sourceRuntimeInstanceId ?? null,
      input.runtimeInstanceId,
      input.status,
      input.stale ? 1 : 0,
      input.consumerId ?? null,
      input.consumerVersion ?? null,
      input.error ?? null,
      event.receivedAt ?? null,
      input.recordedAt,
    )
  return Number(result.changes) > 0
}

export function createApplicationRuntimeStore(db: DatabaseSync): ApplicationRuntimeStore {
  const startRuntime = db.prepare(`
    INSERT INTO application_runtime_instances (
      runtime_instance_id, profile_principal, started_at, stopped_at
    ) VALUES (?, ?, ?, NULL)
    ON CONFLICT(runtime_instance_id) DO UPDATE SET
      profile_principal = excluded.profile_principal,
      started_at = excluded.started_at,
      stopped_at = NULL
  `)
  const stopRuntime = db.prepare(
    'UPDATE application_runtime_instances SET stopped_at = ? WHERE runtime_instance_id = ?',
  )
  const getEvent = db.prepare('SELECT * FROM application_events WHERE message_id = ?')
  const getState = db.prepare(`
    SELECT * FROM application_states
    WHERE profile_principal = ? AND channel_id = ? AND extension_uri = ? AND context_id = ?
  `)
  const upsertState = db.prepare(`
    INSERT INTO application_states (
      profile_principal, channel_id, extension_uri, context_id, consumer_id, consumer_version,
      state_json, task_state, last_event_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_principal, channel_id, extension_uri, context_id) DO UPDATE SET
      consumer_id = excluded.consumer_id,
      consumer_version = excluded.consumer_version,
      state_json = excluded.state_json,
      task_state = excluded.task_state,
      last_event_id = excluded.last_event_id,
      updated_at = excluded.updated_at
  `)
  const insertEffect = db.prepare(`
    INSERT INTO application_effects (
      effect_id, message_id, effect_index, effect_json, status, runtime_instance_id,
      attempts, last_error, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, 0, NULL, ?)
    ON CONFLICT(effect_id) DO NOTHING
  `)

  return {
    startRuntime(input): void {
      startRuntime.run(input.runtimeInstanceId, input.profilePrincipal, input.startedAt)
    },

    stopRuntime(runtimeInstanceId, stoppedAt): void {
      stopRuntime.run(stoppedAt, runtimeInstanceId)
    },

    getEvent(messageId): StoredApplicationEvent | undefined {
      const row = getEvent.get(messageId)
      return row ? toStoredEvent(row) : undefined
    },

    getState(key: ApplicationStateKey): ApplicationStateSnapshot | undefined {
      const row = getState.get(key.profilePrincipal, key.channelId, key.extensionUri, key.contextId)
      return row ? toState(row) : undefined
    },

    commitReduction(input: CommitApplicationReductionInput) {
      return withTx(db, () => {
        const inserted = insertEvent(db, {
          event: input.event,
          runtimeInstanceId: input.runtimeInstanceId,
          status: 'reduced',
          stale: input.stale,
          consumerId: input.consumerId,
          consumerVersion: input.consumerVersion,
          recordedAt: input.recordedAt,
        })
        if (!inserted) return { duplicate: true, effects: [] }
        upsertState.run(
          input.key.profilePrincipal,
          input.key.channelId,
          input.key.extensionUri,
          input.key.contextId,
          input.consumerId,
          input.consumerVersion,
          toJson(input.state ?? null),
          input.taskState,
          input.event.messageId,
          input.recordedAt,
        )
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
          insertEffect.run(
            item.effectId,
            item.messageId,
            item.index,
            toJson(item.effect),
            item.runtimeInstanceId,
            item.updatedAt,
          )
          return item
        })
        return { duplicate: false, effects }
      })
    },

    recordEvent(input): { duplicate: boolean } {
      return { duplicate: !insertEvent(db, input) }
    },

    listEffects(statuses): JournaledApplicationEffect[] {
      if (statuses.length === 0) return []
      const placeholders = statuses.map(() => '?').join(', ')
      return db
        .prepare(
          `SELECT * FROM application_effects WHERE status IN (${placeholders}) ORDER BY updated_at, effect_id`,
        )
        .all(...statuses)
        .map(toEffect)
    },

    markEffect(effectId, status, input): void {
      const result = db
        .prepare(`
          UPDATE application_effects SET
            status = ?,
            runtime_instance_id = ?,
            attempts = attempts + CASE WHEN ? = 'executing' THEN 1 ELSE 0 END,
            last_error = COALESCE(?, last_error),
            updated_at = ?
          WHERE effect_id = ?
        `)
        .run(status, input.runtimeInstanceId, status, input.error ?? null, input.updatedAt, effectId)
      if (Number(result.changes) === 0) throw new Error(`application effect not found: ${effectId}`)
    },

    recoverInterruptedEffects(runtimeInstanceId, updatedAt): number {
      const result = db
        .prepare(`
          UPDATE application_effects SET status = 'needs-reconciliation', updated_at = ?
          WHERE status = 'executing' AND runtime_instance_id <> ?
        `)
        .run(updatedAt, runtimeInstanceId)
      return Number(result.changes)
    },

    listUnfinished(channelId): ApplicationStateSnapshot[] {
      const terminal = ['completed', 'failed', 'canceled', 'rejected']
      const clauses = [
        `task_state NOT IN (${terminal.map(() => '?').join(', ')})`,
        ...(channelId === undefined ? [] : ['channel_id = ?']),
      ]
      const params = [...terminal, ...(channelId === undefined ? [] : [channelId])]
      return db
        .prepare(`SELECT * FROM application_states WHERE ${clauses.join(' AND ')} ORDER BY updated_at`)
        .all(...params)
        .map(toState)
    },
  }
}

function toTaskAuthorization(row: Row): TaskAuthorization {
  return {
    authorizationId: reqStr(row, 'authorization_id'),
    messageId: reqStr(row, 'message_id'),
    taskId: reqStr(row, 'task_id'),
    contextId: reqStr(row, 'context_id'),
    channelId: reqStr(row, 'channel_id'),
    requestedBy: reqStr(row, 'requested_by'),
    prompt: reqStr(row, 'prompt'),
    scope: parseJson(reqStr(row, 'scope_json')),
    status: reqStr(row, 'status') as TaskAuthorization['status'],
    requestedAt: reqStr(row, 'requested_at'),
    receipt: optStr(row, 'receipt_json')
      ? parseJson<AuthorizationReceipt>(reqStr(row, 'receipt_json'))
      : undefined,
  }
}

export interface TaskAuthorizationRepo {
  create(authorization: TaskAuthorization): boolean
  get(authorizationId: string): TaskAuthorization | undefined
  listPending(channelId?: string): TaskAuthorization[]
  decide(authorizationId: string, receipt: AuthorizationReceipt): TaskAuthorization
}

export function createTaskAuthorizationRepo(db: DatabaseSync): TaskAuthorizationRepo {
  const insert = db.prepare(`
    INSERT INTO task_authorizations (
      authorization_id, message_id, task_id, context_id, channel_id, requested_by,
      prompt, scope_json, status, requested_at, receipt_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(authorization_id) DO NOTHING
  `)
  const get = db.prepare('SELECT * FROM task_authorizations WHERE authorization_id = ?')
  const decide = db.prepare(`
    UPDATE task_authorizations SET status = ?, receipt_json = ?
    WHERE authorization_id = ? AND status = 'pending'
  `)
  return {
    create(authorization): boolean {
      return (
        Number(
          insert.run(
            authorization.authorizationId,
            authorization.messageId,
            authorization.taskId,
            authorization.contextId,
            authorization.channelId,
            authorization.requestedBy,
            authorization.prompt,
            toJson(authorization.scope),
            authorization.status,
            authorization.requestedAt,
            authorization.receipt ? toJson(authorization.receipt) : null,
          ).changes,
        ) > 0
      )
    },

    get(authorizationId): TaskAuthorization | undefined {
      const row = get.get(authorizationId)
      return row ? toTaskAuthorization(row) : undefined
    },

    listPending(channelId): TaskAuthorization[] {
      const rows =
        channelId === undefined
          ? db
              .prepare("SELECT * FROM task_authorizations WHERE status = 'pending' ORDER BY requested_at")
              .all()
          : db
              .prepare(
                "SELECT * FROM task_authorizations WHERE status = 'pending' AND channel_id = ? ORDER BY requested_at",
              )
              .all(channelId)
      return rows.map(toTaskAuthorization)
    },

    decide(authorizationId, receipt): TaskAuthorization {
      const status = receipt.decision === 'approve' ? 'approved' : 'rejected'
      const result = decide.run(status, toJson(receipt), authorizationId)
      if (Number(result.changes) === 0) {
        const current = this.get(authorizationId)
        if (!current) {
          throw new AgentCommError(
            'AUTHORIZATION_NOT_FOUND',
            `task authorization not found: ${authorizationId}`,
          )
        }
        if (current.receipt?.decision === receipt.decision) return current
        throw new AgentCommError(
          'AUTHORIZATION_ALREADY_DECIDED',
          `task authorization is already decided: ${authorizationId}`,
        )
      }
      const updated = this.get(authorizationId)
      if (!updated) {
        throw new AgentCommError(
          'AUTHORIZATION_NOT_FOUND',
          `task authorization disappeared: ${authorizationId}`,
        )
      }
      return updated
    },
  }
}
