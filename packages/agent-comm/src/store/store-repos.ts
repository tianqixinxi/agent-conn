import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AgentCard,
  AuditEvent,
  ChannelMode,
  ChannelVisibility,
  InviteScope,
  MsgStatus,
} from '@agent-comm/protocol'
import {
  openDb,
  optNum,
  optStr,
  parseJson,
  parseJsonOpt,
  type Row,
  reqBool,
  reqNum,
  reqStr,
  toJson,
  toJsonOpt,
  withTx,
} from './sqlite.js'

/**
 * 私有 store(每 profile 一份,schema.store.sql)的 repo 层。
 * 只做机械式读写(store 无业务规则):不判权限、不算投递、不解释状态转移——
 * 这些决策都在 engine.ts。JSON 列的编解码在这里完成,但内容本身(payload/card)不解析(I1)。
 */

const STORE_SCHEMA_SQL = readFileSync(new URL('./schema.store.sql', import.meta.url), 'utf8')

// —— identity ——

export interface StoreIdentityRow {
  nodeId: string
  publicKey: string
  privateKeyRef: string
  relays: string[]
}

function toIdentityRow(row: Row): StoreIdentityRow {
  return {
    nodeId: reqStr(row, 'node_id'),
    publicKey: reqStr(row, 'public_key'),
    privateKeyRef: reqStr(row, 'private_key_ref'),
    relays: parseJson<string[]>(reqStr(row, 'relays_json')),
  }
}

function createIdentityRepo(db: DatabaseSync) {
  const getStmt = db.prepare('SELECT * FROM identity LIMIT 1')
  const insertStmt = db.prepare(
    'INSERT INTO identity (node_id, public_key, private_key_ref, relays_json) VALUES (?, ?, ?, ?)',
  )
  function get(): StoreIdentityRow | undefined {
    const row = getStmt.get()
    return row ? toIdentityRow(row) : undefined
  }
  function insertIfAbsent(row: StoreIdentityRow): void {
    if (get()) return
    insertStmt.run(row.nodeId, row.publicKey, row.privateKeyRef, toJson(row.relays))
  }
  return { get, insertIfAbsent }
}

// —— channels(我加入的频道镜像) ——

export interface StoreChannelRow {
  name: string
  home: string
  displayName?: string | undefined
  mode: ChannelMode
  visibility: ChannelVisibility
  description?: string | undefined
  myAlias: string
  scope?: InviteScope | undefined
  e2eKeyRef?: string | undefined
  createdAt: string
}

function toChannelRow(row: Row): StoreChannelRow {
  return {
    name: reqStr(row, 'name'),
    home: reqStr(row, 'home'),
    displayName: optStr(row, 'display_name'),
    mode: reqStr(row, 'mode') as ChannelMode,
    visibility: reqStr(row, 'visibility') as ChannelVisibility,
    description: optStr(row, 'description'),
    myAlias: reqStr(row, 'my_alias'),
    scope: parseJsonOpt<InviteScope>(optStr(row, 'scope_json')),
    e2eKeyRef: optStr(row, 'e2e_key_ref'),
    createdAt: reqStr(row, 'created_at'),
  }
}

function createChannelsRepo(db: DatabaseSync) {
  const getStmt = db.prepare('SELECT * FROM channels WHERE name = ?')
  const listStmt = db.prepare('SELECT * FROM channels ORDER BY created_at ASC')
  const countStmt = db.prepare('SELECT COUNT(*) as c FROM channels')
  const upsertStmt = db.prepare(`
    INSERT INTO channels (name, home, display_name, mode, visibility, description, my_alias, scope_json, e2e_key_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      home = excluded.home,
      display_name = excluded.display_name,
      mode = excluded.mode,
      visibility = excluded.visibility,
      description = excluded.description,
      my_alias = excluded.my_alias,
      scope_json = excluded.scope_json,
      e2e_key_ref = excluded.e2e_key_ref
  `)
  const setModeStmt = db.prepare('UPDATE channels SET mode = ? WHERE name = ?')
  const deleteStmt = db.prepare('DELETE FROM channels WHERE name = ?')
  return {
    get(name: string): StoreChannelRow | undefined {
      const row = getStmt.get(name)
      return row ? toChannelRow(row) : undefined
    },
    list(): StoreChannelRow[] {
      return listStmt.all().map(toChannelRow)
    },
    count(): number {
      const row = countStmt.get()
      return row ? reqNum(row, 'c') : 0
    },
    upsert(row: StoreChannelRow): void {
      upsertStmt.run(
        row.name,
        row.home,
        row.displayName ?? null,
        row.mode,
        row.visibility,
        row.description ?? null,
        row.myAlias,
        toJsonOpt(row.scope),
        row.e2eKeyRef ?? null,
        row.createdAt,
      )
    },
    setMode(name: string, mode: ChannelMode): void {
      setModeStmt.run(mode, name)
    },
    delete(name: string): void {
      deleteStmt.run(name)
    },
  }
}

// —— peers(频道成员镜像) ——

export interface StorePeerRow {
  channel: string
  alias: string
  nodeId: string
  card?: AgentCard | undefined
  updatedAt: string
}

function toPeerRow(row: Row): StorePeerRow {
  return {
    channel: reqStr(row, 'channel'),
    alias: reqStr(row, 'alias'),
    nodeId: reqStr(row, 'node_id'),
    card: parseJsonOpt<AgentCard>(optStr(row, 'card_json')),
    updatedAt: reqStr(row, 'updated_at'),
  }
}

function createPeersRepo(db: DatabaseSync) {
  const upsertStmt = db.prepare(`
    INSERT INTO peers (channel, alias, node_id, card_json, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(channel, alias) DO UPDATE SET
      node_id = excluded.node_id, card_json = excluded.card_json, updated_at = excluded.updated_at
  `)
  const listAllStmt = db.prepare('SELECT * FROM peers ORDER BY channel ASC, alias ASC')
  const listByChannelStmt = db.prepare('SELECT * FROM peers WHERE channel = ? ORDER BY alias ASC')
  return {
    upsert(row: StorePeerRow): void {
      upsertStmt.run(row.channel, row.alias, row.nodeId, toJsonOpt(row.card), row.updatedAt)
    },
    list(channel?: string | undefined): StorePeerRow[] {
      const rows = channel !== undefined ? listByChannelStmt.all(channel) : listAllStmt.all()
      return rows.map(toPeerRow)
    },
  }
}

// —— messages(本地消息副本:我发的 + 拉到的) ——

export interface StoreMessageRow {
  messageId: string
  channel: string
  seq?: number | undefined
  from: string
  to: string
  traceId: string
  replyTo?: string | undefined
  replyBy?: string | undefined
  hop: number
  contentType?: string | undefined
  payload: unknown
  status: MsgStatus
  injectedByHuman: boolean
  ts: string
  deliveredAt?: string | undefined
}

function toMessageRow(row: Row): StoreMessageRow {
  return {
    messageId: reqStr(row, 'message_id'),
    channel: reqStr(row, 'channel'),
    seq: optNum(row, 'seq'),
    from: reqStr(row, 'from_alias'),
    to: reqStr(row, 'to_target'),
    traceId: reqStr(row, 'trace_id'),
    replyTo: optStr(row, 'reply_to'),
    replyBy: optStr(row, 'reply_by'),
    hop: reqNum(row, 'hop'),
    contentType: optStr(row, 'content_type'),
    payload: parseJson(reqStr(row, 'payload_json')),
    status: reqStr(row, 'status') as MsgStatus,
    injectedByHuman: reqBool(row, 'injected_by_human'),
    ts: reqStr(row, 'ts'),
    deliveredAt: optStr(row, 'delivered_at'),
  }
}

function createMessagesRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(`
    INSERT INTO messages (message_id, channel, seq, from_alias, to_target, trace_id, reply_to, reply_by, hop,
      content_type, payload_json, status, injected_by_human, ts, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO NOTHING
  `)
  const getStmt = db.prepare('SELECT * FROM messages WHERE message_id = ?')
  const replaceStmt = db.prepare(`
    UPDATE messages SET
      seq = ?, status = ?, content_type = ?, payload_json = ?, delivered_at = ?
    WHERE message_id = ?
  `)
  return {
    /** 返回 true = 真正插入了新行;false = messageId 已存在(幂等去重,I3) */
    insert(row: StoreMessageRow): boolean {
      const info = insertStmt.run(
        row.messageId,
        row.channel,
        row.seq ?? null,
        row.from,
        row.to,
        row.traceId,
        row.replyTo ?? null,
        row.replyBy ?? null,
        row.hop,
        row.contentType ?? null,
        toJson(row.payload),
        row.status,
        row.injectedByHuman ? 1 : 0,
        row.ts,
        row.deliveredAt ?? null,
      )
      return Number(info.changes) > 0
    },
    get(messageId: string): StoreMessageRow | undefined {
      const row = getStmt.get(messageId)
      return row ? toMessageRow(row) : undefined
    },
    /** 整行替换可变字段(seq/status/content_type/payload/deliveredAt);其余字段(from/to/ts…)不可变 */
    replace(row: StoreMessageRow): void {
      replaceStmt.run(
        row.seq ?? null,
        row.status,
        row.contentType ?? null,
        toJson(row.payload),
        row.deliveredAt ?? null,
        row.messageId,
      )
    },
  }
}

// —— inbox(单收件箱,D1) ——

export interface StoreInboxRow {
  messageId: string
  addedAt: string
  consumedAt?: string | undefined
}

function toInboxRow(row: Row): StoreInboxRow {
  return {
    messageId: reqStr(row, 'message_id'),
    addedAt: reqStr(row, 'added_at'),
    consumedAt: optStr(row, 'consumed_at'),
  }
}

export interface InboxListFilter {
  channel?: string | undefined
  traceId?: string | undefined
  contentType?: string | undefined
  includeConsumed?: boolean | undefined
  limit?: number | undefined
}

export type StoreInboxMessageRow = StoreMessageRow & StoreInboxRow

function createInboxRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(
    'INSERT INTO inbox (message_id, added_at, consumed_at) VALUES (?, ?, NULL) ON CONFLICT(message_id) DO NOTHING',
  )
  const countStmt = db.prepare('SELECT COUNT(*) as c FROM inbox')
  const markConsumedStmt = db.prepare(
    'UPDATE inbox SET consumed_at = ? WHERE message_id = ? AND consumed_at IS NULL',
  )
  const deleteStmt = db.prepare('DELETE FROM inbox WHERE message_id = ?')
  // 驱逐按插入顺序(rowid)取"最老",而不是 added_at(同毫秒并发写入时时间戳可能打平)
  const oldestConsumedStmt = db.prepare(
    'SELECT * FROM inbox WHERE consumed_at IS NOT NULL ORDER BY rowid ASC LIMIT ?',
  )
  const oldestUnconsumedStmt = db.prepare(
    'SELECT * FROM inbox WHERE consumed_at IS NULL ORDER BY rowid ASC LIMIT ?',
  )
  return {
    insert(row: StoreInboxRow): void {
      insertStmt.run(row.messageId, row.addedAt)
    },
    count(): number {
      const row = countStmt.get()
      return row ? reqNum(row, 'c') : 0
    },
    markConsumed(messageId: string, ts: string): void {
      markConsumedStmt.run(ts, messageId)
    },
    delete(messageId: string): void {
      deleteStmt.run(messageId)
    },
    oldestConsumed(limit: number): StoreInboxRow[] {
      if (limit <= 0) return []
      return oldestConsumedStmt.all(limit).map(toInboxRow)
    },
    oldestUnconsumed(limit: number): StoreInboxRow[] {
      if (limit <= 0) return []
      return oldestUnconsumedStmt.all(limit).map(toInboxRow)
    },
    /** inbox ⋈ messages,按 filter 缩小范围(F2) */
    listJoined(filter: InboxListFilter): StoreInboxMessageRow[] {
      const clauses: string[] = []
      const params: (string | number)[] = []
      if (!filter.includeConsumed) {
        clauses.push('inbox.consumed_at IS NULL')
      }
      if (filter.channel !== undefined) {
        clauses.push('messages.channel = ?')
        params.push(filter.channel)
      }
      if (filter.traceId !== undefined) {
        clauses.push('messages.trace_id = ?')
        params.push(filter.traceId)
      }
      if (filter.contentType !== undefined) {
        clauses.push('messages.content_type = ?')
        params.push(filter.contentType)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      const limit = filter.limit ?? 200
      const stmt = db.prepare(`
        SELECT messages.*, inbox.added_at as inbox_added_at, inbox.consumed_at as inbox_consumed_at
        FROM inbox JOIN messages ON messages.message_id = inbox.message_id
        ${where}
        ORDER BY messages.seq ASC, inbox.added_at ASC
        LIMIT ?
      `)
      const rows = stmt.all(...params, limit)
      return rows.map((row) => ({
        ...toMessageRow(row),
        addedAt: reqStr(row, 'inbox_added_at'),
        consumedAt: optStr(row, 'inbox_consumed_at'),
      }))
    },
  }
}

// —— sync_state(每频道同步游标) ——

function createSyncStateRepo(db: DatabaseSync) {
  const getStmt = db.prepare('SELECT last_seq_synced FROM sync_state WHERE channel = ?')
  const hasStmt = db.prepare('SELECT 1 as x FROM sync_state WHERE channel = ?')
  const upsertStmt = db.prepare(`
    INSERT INTO sync_state (channel, last_seq_synced) VALUES (?, ?)
    ON CONFLICT(channel) DO UPDATE SET last_seq_synced = excluded.last_seq_synced
  `)
  return {
    get(channel: string): number {
      const row = getStmt.get(channel)
      return row ? reqNum(row, 'last_seq_synced') : 0
    },
    has(channel: string): boolean {
      return hasStmt.get(channel) !== undefined
    },
    set(channel: string, seq: number): void {
      upsertStmt.run(channel, seq)
    },
  }
}

// —— invites_minted(我铸造的邀请,临时实体) ——

export interface StoreInviteMintedRow {
  link: string
  channel: string
  home: string
  scope?: InviteScope | undefined
  expiresAt?: string | undefined
  maxUses?: number | undefined
  uses: number
  createdAt: string
}

function createInvitesMintedRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(`
    INSERT INTO invites_minted (link, channel, home, scope_json, expires_at, max_uses, uses, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(link) DO NOTHING
  `)
  return {
    insert(row: StoreInviteMintedRow): void {
      insertStmt.run(
        row.link,
        row.channel,
        row.home,
        toJsonOpt(row.scope),
        row.expiresAt ?? null,
        row.maxUses ?? null,
        row.uses,
        row.createdAt,
      )
    },
  }
}

// —— audit(append-only,I6) ——

export interface StoreAuditRow {
  id: number
  ts: string
  event: AuditEvent
  messageId?: string | undefined
  channel?: string | undefined
  fromAlias?: string | undefined
  toTarget?: string | undefined
  actor: string
  detail?: string | undefined
}

export interface StoreAuditFilter {
  channel?: string | undefined
  messageId?: string | undefined
  sinceTs?: string | undefined
  limit?: number | undefined
}

function toAuditRow(row: Row): StoreAuditRow {
  return {
    id: reqNum(row, 'id'),
    ts: reqStr(row, 'ts'),
    event: reqStr(row, 'event') as AuditEvent,
    messageId: optStr(row, 'message_id'),
    channel: optStr(row, 'channel'),
    fromAlias: optStr(row, 'from_alias'),
    toTarget: optStr(row, 'to_target'),
    actor: reqStr(row, 'actor'),
    detail: optStr(row, 'detail'),
  }
}

function createAuditRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(`
    INSERT INTO audit (ts, event, message_id, channel, from_alias, to_target, actor, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  return {
    append(row: Omit<StoreAuditRow, 'id'>): void {
      insertStmt.run(
        row.ts,
        row.event,
        row.messageId ?? null,
        row.channel ?? null,
        row.fromAlias ?? null,
        row.toTarget ?? null,
        row.actor,
        row.detail ?? null,
      )
    },
    query(filter: StoreAuditFilter): StoreAuditRow[] {
      const clauses: string[] = []
      const params: (string | number)[] = []
      if (filter.channel !== undefined) {
        clauses.push('channel = ?')
        params.push(filter.channel)
      }
      if (filter.messageId !== undefined) {
        clauses.push('message_id = ?')
        params.push(filter.messageId)
      }
      if (filter.sinceTs !== undefined) {
        clauses.push('ts >= ?')
        params.push(filter.sinceTs)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      const limit = filter.limit ?? 200
      const stmt = db.prepare(`SELECT * FROM audit ${where} ORDER BY id ASC LIMIT ?`)
      return stmt.all(...params, limit).map(toAuditRow)
    },
  }
}

// —— 组装 ——

export interface StoreHandle {
  path: string
  db: DatabaseSync
  identity: ReturnType<typeof createIdentityRepo>
  channels: ReturnType<typeof createChannelsRepo>
  peers: ReturnType<typeof createPeersRepo>
  messages: ReturnType<typeof createMessagesRepo>
  inbox: ReturnType<typeof createInboxRepo>
  syncState: ReturnType<typeof createSyncStateRepo>
  invitesMinted: ReturnType<typeof createInvitesMintedRepo>
  audit: ReturnType<typeof createAuditRepo>
  withTx<T>(fn: () => T): T
  close(): void
}

export function openStore(path: string): StoreHandle {
  const db = openDb(path, STORE_SCHEMA_SQL)
  const channelColumns = db.prepare("PRAGMA table_info('channels')").all() as Row[]
  if (!channelColumns.some((row) => reqStr(row, 'name') === 'visibility')) {
    db.exec("ALTER TABLE channels ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'")
  }
  return {
    path,
    db,
    identity: createIdentityRepo(db),
    channels: createChannelsRepo(db),
    peers: createPeersRepo(db),
    messages: createMessagesRepo(db),
    inbox: createInboxRepo(db),
    syncState: createSyncStateRepo(db),
    invitesMinted: createInvitesMintedRepo(db),
    audit: createAuditRepo(db),
    withTx<T>(fn: () => T): T {
      return withTx(db, fn)
    },
    close(): void {
      db.close()
    },
  }
}
