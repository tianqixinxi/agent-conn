import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AgentCard,
  AuditEvent,
  ChannelMode,
  InviteScope,
  MessageEnvelope,
  MsgStatus,
} from '@agent-comm/protocol'
import {
  openDb,
  optNum,
  optStr,
  parseJson,
  parseJsonOpt,
  type Row,
  reqNum,
  reqStr,
  toJson,
  toJsonOpt,
  withTx,
} from './sqlite.js'

/**
 * local hub(D5,schema.hub.sql)的 repo 层:本机 local: 频道的家(共享文件)。
 * 与 store-repos.ts 同样只做机械式读写;seq 赋值/intercept 判定/邀请生命周期校验等
 * 业务规则在 engine/local-home.ts。
 */

const HUB_SCHEMA_SQL = readFileSync(new URL('./schema.hub.sql', import.meta.url), 'utf8')

// —— hub_channels ——

export interface HubChannelRow {
  name: string
  displayName?: string | undefined
  mode: ChannelMode
  description?: string | undefined
  createdAt: string
}

function toHubChannelRow(row: Row): HubChannelRow {
  return {
    name: reqStr(row, 'name'),
    displayName: optStr(row, 'display_name'),
    mode: reqStr(row, 'mode') as ChannelMode,
    description: optStr(row, 'description'),
    createdAt: reqStr(row, 'created_at'),
  }
}

function createHubChannelsRepo(db: DatabaseSync) {
  const getStmt = db.prepare('SELECT * FROM hub_channels WHERE name = ?')
  const insertStmt = db.prepare(
    'INSERT INTO hub_channels (name, display_name, mode, description, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  const setModeStmt = db.prepare('UPDATE hub_channels SET mode = ? WHERE name = ?')
  return {
    get(name: string): HubChannelRow | undefined {
      const row = getStmt.get(name)
      return row ? toHubChannelRow(row) : undefined
    },
    insert(row: HubChannelRow): void {
      insertStmt.run(row.name, row.displayName ?? null, row.mode, row.description ?? null, row.createdAt)
    },
    setMode(name: string, mode: ChannelMode): void {
      setModeStmt.run(mode, name)
    },
  }
}

// —— hub_members ——

export interface HubMemberRow {
  channel: string
  alias: string
  nodeId: string
  publicKey?: string | undefined
  scope?: InviteScope | undefined
  card?: AgentCard | undefined
  joinedAt: string
}

function toHubMemberRow(row: Row): HubMemberRow {
  return {
    channel: reqStr(row, 'channel'),
    alias: reqStr(row, 'alias'),
    nodeId: reqStr(row, 'node_id'),
    publicKey: optStr(row, 'public_key'),
    scope: parseJsonOpt<InviteScope>(optStr(row, 'scope_json')),
    card: parseJsonOpt<AgentCard>(optStr(row, 'card_json')),
    joinedAt: reqStr(row, 'joined_at'),
  }
}

function createHubMembersRepo(db: DatabaseSync) {
  const getStmt = db.prepare('SELECT * FROM hub_members WHERE channel = ? AND alias = ?')
  const getByNodeStmt = db.prepare('SELECT * FROM hub_members WHERE channel = ? AND node_id = ? LIMIT 1')
  const listStmt = db.prepare('SELECT * FROM hub_members WHERE channel = ? ORDER BY joined_at ASC')
  const insertStmt = db.prepare(`
    INSERT INTO hub_members (channel, alias, node_id, public_key, scope_json, card_json, joined_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const updateCardAndKeyStmt = db.prepare(
    'UPDATE hub_members SET public_key = ?, card_json = ? WHERE channel = ? AND alias = ?',
  )
  const deleteStmt = db.prepare('DELETE FROM hub_members WHERE channel = ? AND alias = ?')
  return {
    get(channel: string, alias: string): HubMemberRow | undefined {
      const row = getStmt.get(channel, alias)
      return row ? toHubMemberRow(row) : undefined
    },
    getByNode(channel: string, nodeId: string): HubMemberRow | undefined {
      const row = getByNodeStmt.get(channel, nodeId)
      return row ? toHubMemberRow(row) : undefined
    },
    list(channel: string): HubMemberRow[] {
      return listStmt.all(channel).map(toHubMemberRow)
    },
    insert(row: HubMemberRow): void {
      insertStmt.run(
        row.channel,
        row.alias,
        row.nodeId,
        row.publicKey ?? null,
        toJsonOpt(row.scope),
        toJsonOpt(row.card),
        row.joinedAt,
      )
    },
    updateCardAndKey(
      channel: string,
      alias: string,
      publicKey: string | undefined,
      card: AgentCard | undefined,
    ): void {
      updateCardAndKeyStmt.run(publicKey ?? null, toJsonOpt(card), channel, alias)
    },
    delete(channel: string, alias: string): void {
      deleteStmt.run(channel, alias)
    },
  }
}

// —— hub_messages(频道日志:seq 在 channel 内单调,I2) ——

export interface HubMessageRow {
  channel: string
  seq: number
  messageId: string
  envelope: MessageEnvelope
  status: MsgStatus
  ts: string
  decidedBy?: string | undefined
}

function toHubMessageRow(row: Row): HubMessageRow {
  return {
    channel: reqStr(row, 'channel'),
    seq: reqNum(row, 'seq'),
    messageId: reqStr(row, 'message_id'),
    envelope: parseJson<MessageEnvelope>(reqStr(row, 'envelope_json')),
    status: reqStr(row, 'status') as MsgStatus,
    ts: reqStr(row, 'ts'),
    decidedBy: optStr(row, 'decided_by'),
  }
}

function createHubMessagesRepo(db: DatabaseSync) {
  const maxSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) as m FROM hub_messages WHERE channel = ?')
  const getByIdStmt = db.prepare('SELECT * FROM hub_messages WHERE channel = ? AND message_id = ?')
  const insertStmt = db.prepare(`
    INSERT INTO hub_messages (channel, seq, message_id, envelope_json, status, ts, decided_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const replaceStmt = db.prepare(
    'UPDATE hub_messages SET status = ?, envelope_json = ?, decided_by = ? WHERE channel = ? AND seq = ?',
  )
  const listHeldStmt = db.prepare(
    `SELECT * FROM hub_messages WHERE channel = ? AND status = 'held' ORDER BY seq ASC`,
  )
  const listFromStmt = db.prepare(
    'SELECT * FROM hub_messages WHERE channel = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
  )
  return {
    /** 单事务内先调用本方法拿 seq,再 insert(I2:seq = COALESCE(MAX(seq),0)+1) */
    nextSeq(channel: string): number {
      const row = maxSeqStmt.get(channel)
      return (row ? reqNum(row, 'm') : 0) + 1
    },
    getByMessageId(channel: string, messageId: string): HubMessageRow | undefined {
      const row = getByIdStmt.get(channel, messageId)
      return row ? toHubMessageRow(row) : undefined
    },
    insert(row: HubMessageRow): void {
      insertStmt.run(
        row.channel,
        row.seq,
        row.messageId,
        toJson(row.envelope),
        row.status,
        row.ts,
        row.decidedBy ?? null,
      )
    },
    /** 只改 status/envelope/decidedBy;seq/messageId/ts 不可变(append-only 日志行) */
    replace(row: HubMessageRow): void {
      replaceStmt.run(row.status, toJson(row.envelope), row.decidedBy ?? null, row.channel, row.seq)
    },
    listHeld(channel: string): HubMessageRow[] {
      return listHeldStmt.all(channel).map(toHubMessageRow)
    },
    listFrom(channel: string, afterSeq: number, limit: number): HubMessageRow[] {
      return listFromStmt.all(channel, afterSeq, limit).map(toHubMessageRow)
    },
  }
}

// —— hub_cursors ——

function createHubCursorsRepo(db: DatabaseSync) {
  const getStmt = db.prepare('SELECT acked_seq FROM hub_cursors WHERE channel = ? AND node_id = ?')
  const upsertStmt = db.prepare(`
    INSERT INTO hub_cursors (channel, node_id, acked_seq, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(channel, node_id) DO UPDATE SET
      acked_seq = MAX(acked_seq, excluded.acked_seq), updated_at = excluded.updated_at
  `)
  return {
    get(channel: string, nodeId: string): number {
      const row = getStmt.get(channel, nodeId)
      return row ? reqNum(row, 'acked_seq') : 0
    },
    upsert(channel: string, nodeId: string, seq: number, ts: string): void {
      upsertStmt.run(channel, nodeId, seq, ts)
    },
  }
}

// —— hub_invites(token 只存 sha256 哈希) ——

export interface HubInviteRow {
  tokenHash: string
  channel: string
  scope?: InviteScope | undefined
  expiresAt?: string | undefined
  maxUses?: number | undefined
  uses: number
  createdByNode?: string | undefined
  createdAt: string
}

function toHubInviteRow(row: Row): HubInviteRow {
  return {
    tokenHash: reqStr(row, 'token_hash'),
    channel: reqStr(row, 'channel'),
    scope: parseJsonOpt<InviteScope>(optStr(row, 'scope_json')),
    expiresAt: optStr(row, 'expires_at'),
    maxUses: optNum(row, 'max_uses'),
    uses: reqNum(row, 'uses'),
    createdByNode: optStr(row, 'created_by_node'),
    createdAt: reqStr(row, 'created_at'),
  }
}

function createHubInvitesRepo(db: DatabaseSync) {
  const getStmt = db.prepare('SELECT * FROM hub_invites WHERE token_hash = ?')
  const insertStmt = db.prepare(`
    INSERT INTO hub_invites (token_hash, channel, scope_json, expires_at, max_uses, uses, created_by_node, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `)
  const incrementStmt = db.prepare('UPDATE hub_invites SET uses = uses + 1 WHERE token_hash = ?')
  return {
    getByHash(tokenHash: string): HubInviteRow | undefined {
      const row = getStmt.get(tokenHash)
      return row ? toHubInviteRow(row) : undefined
    },
    insert(row: Omit<HubInviteRow, 'uses'>): void {
      insertStmt.run(
        row.tokenHash,
        row.channel,
        toJsonOpt(row.scope),
        row.expiresAt ?? null,
        row.maxUses ?? null,
        row.createdByNode ?? null,
        row.createdAt,
      )
    },
    incrementUses(tokenHash: string): void {
      incrementStmt.run(tokenHash)
    },
  }
}

// —— hub_audit ——

export interface HubAuditRow {
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

function createHubAuditRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(`
    INSERT INTO hub_audit (ts, event, message_id, channel, from_alias, to_target, actor, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  return {
    append(row: Omit<HubAuditRow, 'id'>): void {
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
  }
}

// —— 组装 ——

export interface HubHandle {
  path: string
  db: DatabaseSync
  channels: ReturnType<typeof createHubChannelsRepo>
  members: ReturnType<typeof createHubMembersRepo>
  messages: ReturnType<typeof createHubMessagesRepo>
  cursors: ReturnType<typeof createHubCursorsRepo>
  invites: ReturnType<typeof createHubInvitesRepo>
  audit: ReturnType<typeof createHubAuditRepo>
  withTx<T>(fn: () => T): T
  close(): void
}

export function openHubDb(path: string): HubHandle {
  const db = openDb(path, HUB_SCHEMA_SQL)
  return {
    path,
    db,
    channels: createHubChannelsRepo(db),
    members: createHubMembersRepo(db),
    messages: createHubMessagesRepo(db),
    cursors: createHubCursorsRepo(db),
    invites: createHubInvitesRepo(db),
    audit: createHubAuditRepo(db),
    withTx<T>(fn: () => T): T {
      return withTx(db, fn)
    },
    close(): void {
      db.close()
    },
  }
}
