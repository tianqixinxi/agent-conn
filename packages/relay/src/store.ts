import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type AgentCard,
  AgentCommError,
  type ChannelMode,
  type ChannelVisibility,
  ICEBREAK_DEFAULTS,
  type InviteScope,
  type Message,
  type MsgStatus,
  newJoinToken,
  nowIso,
  type WireEnvelope,
} from '@agent-comm/protocol'
import { sha256Hex } from './hash.js'

/**
 * W4 存储层(node:sqlite DatabaseSync,relay 自持,DESIGN §3 relay 行 / 上游 spec §4.2)。
 * relay 没有独立的 engine 层,鉴权之外的业务规则——from 盖戳(§2.3)、messageId 幂等、seq
 * 分配(I2)、破冰限流(D3.2)、retention——都收在这里;app.ts 只做 HTTP 转译。
 * 不 import agent-comm 任何代码(信任边界:relay 只依赖 protocol)。
 */

// ———————————————————————————————————————————— 行类型(与 schema.sql 对应)

interface ChannelRow {
  name: string
  display_name: string | null
  mode: ChannelMode
  visibility: ChannelVisibility
  description: string | null
  head_seq: number
  created_at: string
}

export interface MemberRow {
  channel: string
  alias: string
  node_id: string
  public_key: string
  scope_json: string | null
  card_json: string | null
  joined_at: string
  last_seen_at: string
  join_seq: number
}

interface MessageRow {
  channel: string
  seq: number
  message_id: string
  from_alias: string
  envelope_json: string
  status: MsgStatus
  ts: string
  decided_by: string | null
}

interface InviteRow {
  token_hash: string
  channel: string
  scope_json: string | null
  expires_at: string | null
  max_uses: number
  uses: number
  created_by_node: string | null
  created_at: string
}

export interface RelayDb {
  raw: DatabaseSync
}

// ———————————————————————————————————————————— 常量

/** 硬 TTL(§4.2 默认 30d):不论是否全员 ack,超过即清除 */
const RETENTION_HARD_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 软 TTL(工单):全员 ack 之后再等这么久才清除 */
const RETENTION_ACKED_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 破冰限流(D3.2)429 的建议重试间隔。ICEBREAK_DEFAULTS(wire.ts)只冻结了 maxBeforeReply,
 *  这个数值不属契约,按工单原文"比如 60000"实现,细节见最终汇报。 */
const ICEBREAK_RETRY_AFTER_MS = 60_000
/** DatabaseSync busy_timeout(ms);高于 agent-comm/store 注释建议的 2000ms 下限 */
const BUSY_TIMEOUT_MS = 5_000
/** A runtime is considered online while signed channel activity renews this soft lease. */
export const PRESENCE_LEASE_MS = 45_000

// ———————————————————————————————————————————— 打开 / schema

export function openDb(dbPath: string): RelayDb {
  if (dbPath !== ':memory:') {
    // DatabaseSync 能创建数据库文件，但不会创建父目录。relay 的常见启动方式会把文件放在
    // .tmp/ 或 data/ 下，因此在打开前幂等创建目录。
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
  }
  const raw = new DatabaseSync(dbPath)
  // WAL 只对文件库有意义;':memory:' 库下 PRAGMA 会被 SQLite 静默忽略(退化为 memory
  // journal),这里显式跳过以让"内存库不开 WAL"这个意图在代码里可读。
  if (dbPath !== ':memory:') {
    raw.exec('PRAGMA journal_mode = WAL')
  }
  raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  raw.exec('PRAGMA foreign_keys = ON')
  const schemaSql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
  raw.exec(schemaSql)
  const channelColumns = raw.prepare("PRAGMA table_info('channels')").all() as { name: string }[]
  if (!channelColumns.some((column) => column.name === 'visibility')) {
    raw.exec("ALTER TABLE channels ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'")
  }
  const memberColumns = raw.prepare("PRAGMA table_info('members')").all() as { name: string }[]
  if (!memberColumns.some((column) => column.name === 'last_seen_at')) {
    raw.exec('ALTER TABLE members ADD COLUMN last_seen_at TEXT')
    raw.exec('UPDATE members SET last_seen_at = joined_at WHERE last_seen_at IS NULL')
  }
  const db: RelayDb = { raw }
  // 启动时清一遍所有频道(D8:不装定时任务,只在启动 + 每次写后惰性清理)
  const rows = raw.prepare('SELECT name FROM channels').all() as { name: string }[]
  for (const { name } of rows) cleanupRetention(db, name)
  return db
}

// ———————————————————————————————————————————— 鉴权中间件用:跨频道查 nodeId 已注册的公钥

/** 按成员表(nodeId→publicKey)查——不限定频道,因为同一身份可能先在别的频道注册过 */
export function findMemberPublicKeyByNodeId(db: RelayDb, nodeId: string): string | undefined {
  const row = db.raw.prepare('SELECT public_key FROM members WHERE node_id = ? LIMIT 1').get(nodeId) as
    | { public_key: string }
    | undefined
  return row?.public_key
}

// ———————————————————————————————————————————— 成员校验(messages/ack/invites/members/card 共用)

function getChannelRow(db: RelayDb, channel: string): ChannelRow | undefined {
  return db.raw.prepare('SELECT * FROM channels WHERE name = ?').get(channel) as ChannelRow | undefined
}

function getMemberByChannelNode(db: RelayDb, channel: string, nodeId: string): MemberRow | undefined {
  return db.raw.prepare('SELECT * FROM members WHERE channel = ? AND node_id = ?').get(channel, nodeId) as
    | MemberRow
    | undefined
}

/** 频道不存在→CHANNEL_NOT_FOUND(404);调用者非成员→NOT_MEMBER(403) */
export function requireMember(db: RelayDb, channel: string, nodeId: string): MemberRow {
  const chRow = getChannelRow(db, channel)
  if (!chRow) throw new AgentCommError('CHANNEL_NOT_FOUND', `channel not found: ${channel}`)
  const member = getMemberByChannelNode(db, channel, nodeId)
  if (!member) throw new AgentCommError('NOT_MEMBER', `node is not a member of channel: ${channel}`)
  const lastSeenAt = nowIso()
  db.raw
    .prepare('UPDATE members SET last_seen_at = ? WHERE channel = ? AND node_id = ?')
    .run(lastSeenAt, channel, nodeId)
  return { ...member, last_seen_at: lastSeenAt }
}

// ———————————————————————————————————————————— 频道 + 成员 → wire 响应形状

export interface JoinLikeResult {
  channel: string
  mode: ChannelMode
  visibility: ChannelVisibility
  myAlias: string
  members: {
    alias: string
    nodeId: string
    card?: AgentCard
    lastSeenAt: string
    online: boolean
  }[]
}

export function listMembers(db: RelayDb, channel: string): MemberRow[] {
  return db.raw
    .prepare('SELECT * FROM members WHERE channel = ? ORDER BY joined_at ASC')
    .all(channel) as unknown as MemberRow[]
}

export interface PublicChannelSummary {
  name: string
  displayName?: string | undefined
  description?: string | undefined
  createdAt: string
  members: number
  messages: number
  onlineMembers: number
  lastActivityAt?: string | undefined
}

export interface PublicChannelMessage {
  seq: number
  messageId: string
  from: string
  to: string
  contentType?: string | undefined
  payload: unknown
  ts: string
}

function publicSummaryFromRow(row: {
  name: string
  display_name: string | null
  description: string | null
  created_at: string
  member_count: number
  message_count: number
  online_member_count: number
  last_activity_at: string | null
}): PublicChannelSummary {
  return {
    name: row.name,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    ...(row.description ? { description: row.description } : {}),
    createdAt: row.created_at,
    members: row.member_count,
    messages: row.message_count,
    onlineMembers: row.online_member_count,
    ...(row.last_activity_at ? { lastActivityAt: row.last_activity_at } : {}),
  }
}

const PUBLIC_SUMMARY_SELECT = `
  SELECT c.name, c.display_name, c.description, c.created_at,
    (SELECT COUNT(*) FROM members mb WHERE mb.channel = c.name) AS member_count,
    (SELECT COUNT(*) FROM messages msg WHERE msg.channel = c.name AND msg.status = 'delivered') AS message_count,
    (SELECT COUNT(*) FROM members online_mb WHERE online_mb.channel = c.name
      AND unixepoch(online_mb.last_seen_at) >= unixepoch('now') - ${PRESENCE_LEASE_MS / 1000}) AS online_member_count,
    (SELECT MAX(msg.ts) FROM messages msg WHERE msg.channel = c.name AND msg.status = 'delivered') AS last_activity_at
  FROM channels c
`

export function listPublicChannels(db: RelayDb): PublicChannelSummary[] {
  const rows = db.raw
    .prepare(
      `${PUBLIC_SUMMARY_SELECT} WHERE c.visibility = 'public' ORDER BY last_activity_at DESC, c.created_at DESC`,
    )
    .all() as unknown as Parameters<typeof publicSummaryFromRow>[0][]
  return rows.map(publicSummaryFromRow)
}

export function getPublicChannel(db: RelayDb, channel: string): PublicChannelSummary | undefined {
  const row = db.raw
    .prepare(`${PUBLIC_SUMMARY_SELECT} WHERE c.visibility = 'public' AND c.name = ?`)
    .get(channel) as Parameters<typeof publicSummaryFromRow>[0] | undefined
  return row ? publicSummaryFromRow(row) : undefined
}

export function listPublicChannelMessages(
  db: RelayDb,
  channel: string,
  after: number,
  limit: number,
): PublicChannelMessage[] | undefined {
  if (!getPublicChannel(db, channel)) return undefined
  const rows = db.raw
    .prepare(
      `SELECT seq, message_id, envelope_json, ts FROM messages
       WHERE channel = ? AND status = 'delivered' AND seq > ? ORDER BY seq ASC LIMIT ?`,
    )
    .all(channel, after, limit) as unknown as {
    seq: number
    message_id: string
    envelope_json: string
    ts: string
  }[]
  return rows.map((row) => {
    const envelope = JSON.parse(row.envelope_json) as WireEnvelope
    return {
      seq: row.seq,
      messageId: row.message_id,
      from: envelope.from,
      to: envelope.to,
      ...(envelope.contentType ? { contentType: envelope.contentType } : {}),
      payload: envelope.payload,
      ts: row.ts,
    }
  })
}

export function listRecentPublicChannelMessages(
  db: RelayDb,
  channel: string,
  limit: number,
): PublicChannelMessage[] | undefined {
  if (!getPublicChannel(db, channel)) return undefined
  const rows = db.raw
    .prepare(
      `SELECT seq, message_id, envelope_json, ts FROM messages
       WHERE channel = ? AND status = 'delivered' ORDER BY seq DESC LIMIT ?`,
    )
    .all(channel, limit) as unknown as {
    seq: number
    message_id: string
    envelope_json: string
    ts: string
  }[]
  return rows.reverse().map((row) => {
    const envelope = JSON.parse(row.envelope_json) as WireEnvelope
    return {
      seq: row.seq,
      messageId: row.message_id,
      from: envelope.from,
      to: envelope.to,
      ...(envelope.contentType ? { contentType: envelope.contentType } : {}),
      payload: envelope.payload,
      ts: row.ts,
    }
  })
}

export function memberRowToWire(m: MemberRow): {
  alias: string
  nodeId: string
  card?: AgentCard
  lastSeenAt: string
  online: boolean
} {
  return {
    alias: m.alias,
    nodeId: m.node_id,
    ...(m.card_json ? { card: JSON.parse(m.card_json) as AgentCard } : {}),
    lastSeenAt: m.last_seen_at,
    online: Date.now() - Date.parse(m.last_seen_at) <= PRESENCE_LEASE_MS,
  }
}

function buildJoinLikeResult(
  db: RelayDb,
  channel: string,
  myAlias: string,
  mode: ChannelMode,
): JoinLikeResult {
  return {
    channel,
    mode,
    visibility: getChannelRow(db, channel)?.visibility ?? 'private',
    myAlias,
    members: listMembers(db, channel).map(memberRowToWire),
  }
}

// ———————————————————————————————————————————— audit(I6 的 relay 侧子集,详见最终汇报)

function insertAudit(
  db: RelayDb,
  entry: {
    event: 'connected' | 'held' | 'delivered' | 'edited'
    messageId?: string
    channel?: string
    fromAlias?: string
    toTarget?: string
    actor: string
    detail?: string
  },
): void {
  db.raw
    .prepare(
      `INSERT INTO audit (ts, event, message_id, channel, from_alias, to_target, actor, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nowIso(),
      entry.event,
      entry.messageId ?? null,
      entry.channel ?? null,
      entry.fromAlias ?? null,
      entry.toTarget ?? null,
      entry.actor,
      entry.detail ?? null,
    )
}

// ———————————————————————————————————————————— bootstrap:POST /ch/:channel/create(relay 自定,见 app.ts 注释)

export function createChannelBootstrap(
  db: RelayDb,
  args: {
    channel: string
    alias: string
    nodeId: string
    publicKey: string
    mode?: ChannelMode
    visibility?: ChannelVisibility
    displayName?: string
    description?: string
    card?: AgentCard
  },
): JoinLikeResult {
  if (getChannelRow(db, args.channel)) {
    throw new AgentCommError('CHANNEL_EXISTS', `channel already exists: ${args.channel}`)
  }
  const mode: ChannelMode = args.mode ?? 'auto'
  const visibility: ChannelVisibility = args.visibility ?? 'private'
  db.raw.exec('BEGIN')
  try {
    db.raw
      .prepare(
        `INSERT INTO channels (name, display_name, mode, visibility, description, head_seq, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(args.channel, args.displayName ?? null, mode, visibility, args.description ?? null, nowIso())
    db.raw
      .prepare(
        `INSERT INTO members (channel, alias, node_id, public_key, scope_json, card_json, joined_at, last_seen_at, join_seq)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)`,
      )
      .run(
        args.channel,
        args.alias,
        args.nodeId,
        args.publicKey,
        args.card ? JSON.stringify(args.card) : null,
        nowIso(),
        nowIso(),
      )
    insertAudit(db, {
      event: 'connected',
      channel: args.channel,
      fromAlias: args.alias,
      actor: `agent:${args.alias}`,
      detail: 'bootstrap channel create (POST /ch/:channel/create)',
    })
    db.raw.exec('COMMIT')
  } catch (e) {
    db.raw.exec('ROLLBACK')
    throw e
  }
  return buildJoinLikeResult(db, args.channel, args.alias, mode)
}

// ———————————————————————————————————————————— POST /join

export function joinViaInvite(
  db: RelayDb,
  args: { joinToken: string; alias: string; nodeId: string; publicKey: string; card?: AgentCard },
): JoinLikeResult {
  const tokenHash = sha256Hex(args.joinToken)
  const invite = db.raw.prepare('SELECT * FROM invites WHERE token_hash = ?').get(tokenHash) as
    | InviteRow
    | undefined
  if (!invite) throw new AgentCommError('INVITE_INVALID', 'invite token not recognized')

  const channel = invite.channel
  const chRow = getChannelRow(db, channel)
  // 邀请表里的频道名即权威(工单原文);理论上不会出现频道被删但邀请仍在的情况,防御式处理。
  if (!chRow) throw new AgentCommError('CHANNEL_NOT_FOUND', `channel not found: ${channel}`)

  const existingByAlias = db.raw
    .prepare('SELECT * FROM members WHERE channel = ? AND alias = ?')
    .get(channel, args.alias) as MemberRow | undefined
  if (existingByAlias) {
    if (existingByAlias.node_id === args.nodeId) {
      // 同 (nodeId, alias) 重复 join:幂等返回现状,不重复扣 uses / 不重复插入(工单原文)
      db.raw
        .prepare('UPDATE members SET last_seen_at = ? WHERE channel = ? AND node_id = ?')
        .run(nowIso(), channel, args.nodeId)
      return buildJoinLikeResult(db, channel, args.alias, chRow.mode)
    }
    throw new AgentCommError('ALIAS_TAKEN', `alias already taken in channel: ${args.alias}`)
  }
  // 同一 nodeId 已经在这个频道下用别的 alias 注册过:不允许一个 (channel, nodeId) 映射到多个
  // alias——from 盖戳(§2.3)需要"该 nodeId 注册的 alias"是唯一的,否则无法判定该盖哪个。
  // 工单没有覆盖这个分支,这是本实现补的防御性判断,详见最终汇报。
  const existingByNode = getMemberByChannelNode(db, channel, args.nodeId)
  if (existingByNode) {
    throw new AgentCommError(
      'CONFLICT',
      `node already joined channel ${channel} as alias '${existingByNode.alias}'`,
    )
  }

  const nowMs = Date.now()
  if (invite.expires_at && new Date(invite.expires_at).getTime() < nowMs) {
    throw new AgentCommError('INVITE_EXPIRED', 'invite token expired')
  }
  if (invite.uses >= invite.max_uses) {
    throw new AgentCommError('INVITE_EXHAUSTED', 'invite token has no remaining uses')
  }

  db.raw.exec('BEGIN')
  try {
    db.raw.prepare('UPDATE invites SET uses = uses + 1 WHERE token_hash = ?').run(tokenHash)
    db.raw
      .prepare(
        `INSERT INTO members (channel, alias, node_id, public_key, scope_json, card_json, joined_at, last_seen_at, join_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        channel,
        args.alias,
        args.nodeId,
        args.publicKey,
        invite.scope_json,
        args.card ? JSON.stringify(args.card) : null,
        nowIso(),
        nowIso(),
        chRow.head_seq,
      )
    insertAudit(db, {
      event: 'connected',
      channel,
      fromAlias: args.alias,
      actor: `agent:${args.alias}`,
      detail: 'joined via invite',
    })
    db.raw.exec('COMMIT')
  } catch (e) {
    db.raw.exec('ROLLBACK')
    throw e
  }
  return buildJoinLikeResult(db, channel, args.alias, chRow.mode)
}

// ———————————————————————————————————————————— POST /ch/:channel/invites

export function createInvite(
  db: RelayDb,
  args: { channel: string; scope?: InviteScope; ttlMs?: number; maxUses?: number; createdByNode: string },
): { joinToken: string; expiresAt?: string } {
  const token = newJoinToken()
  const tokenHash = sha256Hex(token)
  const expiresAt = args.ttlMs !== undefined ? new Date(Date.now() + args.ttlMs).toISOString() : null
  const maxUses = args.maxUses ?? 1
  db.raw
    .prepare(
      `INSERT INTO invites (token_hash, channel, scope_json, expires_at, max_uses, uses, created_by_node, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      tokenHash,
      args.channel,
      args.scope ? JSON.stringify(args.scope) : null,
      expiresAt,
      maxUses,
      args.createdByNode,
      nowIso(),
    )
  return { joinToken: token, ...(expiresAt ? { expiresAt } : {}) }
}

// ———————————————————————————————————————————— POST /ch/:channel/card

export function updateCard(db: RelayDb, args: { channel: string; nodeId: string; card: AgentCard }): void {
  const member = requireMember(db, args.channel, args.nodeId)
  db.raw
    .prepare('UPDATE members SET card_json = ? WHERE channel = ? AND alias = ?')
    .run(JSON.stringify(args.card), args.channel, member.alias)
}

// ———————————————————————————————————————————— POST /ch/:channel/messages

export interface AppendResultItem {
  messageId: string
  seq: number
  status: MsgStatus
  duplicate?: boolean
}

/** 破冰是否已解除:加入后(seq > joinSeq)有没有"别人"(from_alias != 自己)发过消息 */
function hasPeerReplied(db: RelayDb, channel: string, joinSeq: number, alias: string): boolean {
  const row = db.raw
    .prepare('SELECT 1 as x FROM messages WHERE channel = ? AND seq > ? AND from_alias != ? LIMIT 1')
    .get(channel, joinSeq, alias) as { x: number } | undefined
  return row !== undefined
}

/** 加入后(seq > joinSeq)这个成员自己已经发了多少条 */
function countSentSinceJoin(db: RelayDb, channel: string, joinSeq: number, alias: string): number {
  const row = db.raw
    .prepare('SELECT COUNT(*) as c FROM messages WHERE channel = ? AND seq > ? AND from_alias = ?')
    .get(channel, joinSeq, alias) as { c: number }
  return row.c
}

export function appendMessages(
  db: RelayDb,
  args: { channel: string; nodeId: string; envelopes: WireEnvelope[] },
): AppendResultItem[] {
  const member = requireMember(db, args.channel, args.nodeId)
  const chRow = getChannelRow(db, args.channel)
  if (!chRow) throw new AgentCommError('CHANNEL_NOT_FOUND', `channel not found: ${args.channel}`)

  if (chRow.mode === 'paused') {
    throw new AgentCommError('RATE_LIMITED', `channel is paused: ${args.channel}`)
  }

  // 破冰限流(D3.2):加入后如果还没有"其他成员"在本频道发过消息,累计上行不能超过
  // ICEBREAK_DEFAULTS.maxBeforeReply。按整批请求检查——PostMessagesRespSchema 只有
  // `accepted` 一个字段,没给"部分失败"建模,所以一超限就整批 429,不做部分接受
  // (这点工单没有明说,是本实现按响应 schema 形状反推的判断,已在最终汇报里说明)。
  if (!hasPeerReplied(db, args.channel, member.join_seq, member.alias)) {
    const priorCount = countSentSinceJoin(db, args.channel, member.join_seq, member.alias)
    if (priorCount + args.envelopes.length > ICEBREAK_DEFAULTS.maxBeforeReply) {
      throw new AgentCommError('RATE_LIMITED', 'icebreak limit exceeded: no reply yet from other members', {
        retryAfterMs: ICEBREAK_RETRY_AFTER_MS,
      })
    }
  }

  const results: AppendResultItem[] = []
  db.raw.exec('BEGIN')
  try {
    let headSeq = chRow.head_seq
    for (const env of args.envelopes) {
      const existing = db.raw
        .prepare('SELECT * FROM messages WHERE channel = ? AND message_id = ?')
        .get(args.channel, env.messageId) as MessageRow | undefined
      if (existing) {
        results.push({
          messageId: env.messageId,
          seq: existing.seq,
          status: existing.status,
          duplicate: true,
        })
        continue
      }

      // from 盖戳(§2.3):信封 from 必须等于该 nodeId 注册的 alias,否则改写并 audit
      let stampedFrom = env.from
      if (env.from !== member.alias) {
        stampedFrom = member.alias
        insertAudit(db, {
          event: 'edited',
          messageId: env.messageId,
          channel: args.channel,
          fromAlias: member.alias,
          toTarget: env.to,
          actor: `agent:${member.alias}`,
          detail: `from 声称='${env.from}' 改写为注册 alias='${member.alias}'`,
        })
      }
      const stampedEnvelope = { ...env, from: stampedFrom }

      headSeq += 1
      const seq = headSeq
      const status: MsgStatus = chRow.mode === 'intercept' ? 'held' : 'delivered'
      db.raw
        .prepare(
          `INSERT INTO messages (channel, seq, message_id, from_alias, envelope_json, status, ts, decided_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(args.channel, seq, env.messageId, stampedFrom, JSON.stringify(stampedEnvelope), status, nowIso())
      insertAudit(db, {
        event: status === 'held' ? 'held' : 'delivered',
        messageId: env.messageId,
        channel: args.channel,
        fromAlias: stampedFrom,
        toTarget: env.to,
        actor: `agent:${member.alias}`,
      })
      results.push({ messageId: env.messageId, seq, status })
    }
    db.raw.prepare('UPDATE channels SET head_seq = ? WHERE name = ?').run(headSeq, args.channel)
    db.raw.exec('COMMIT')
  } catch (e) {
    db.raw.exec('ROLLBACK')
    throw e
  }
  cleanupRetention(db, args.channel)
  return results
}

// ———————————————————————————————————————————— GET /ch/:channel/messages

function rowToWireMessage(row: MessageRow): Message {
  const envelope = JSON.parse(row.envelope_json) as Record<string, unknown>
  return { ...envelope, seq: row.seq, status: row.status } as Message
}

export function pullMessages(
  db: RelayDb,
  args: { channel: string; after: number; limit: number },
): { messages: Message[]; head: number } {
  const chRow = getChannelRow(db, args.channel)
  if (!chRow) throw new AgentCommError('CHANNEL_NOT_FOUND', `channel not found: ${args.channel}`)
  const rows = db.raw
    .prepare(
      `SELECT * FROM messages
       WHERE channel = ? AND seq > ? AND status NOT IN ('held', 'dropped')
       ORDER BY seq ASC LIMIT ?`,
    )
    .all(args.channel, args.after, args.limit) as unknown as MessageRow[]
  return { messages: rows.map(rowToWireMessage), head: chRow.head_seq }
}

// ———————————————————————————————————————————— POST /ch/:channel/ack

export function ackCursor(db: RelayDb, args: { channel: string; nodeId: string; seq: number }): void {
  requireMember(db, args.channel, args.nodeId)
  db.raw
    .prepare(
      `INSERT INTO cursors (channel, node_id, acked_seq, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (channel, node_id) DO UPDATE SET
         acked_seq = MAX(acked_seq, excluded.acked_seq),
         updated_at = excluded.updated_at`,
    )
    .run(args.channel, args.nodeId, args.seq, nowIso())
  cleanupRetention(db, args.channel)
}

// ———————————————————————————————————————————— retention(每次写后惰性清理,D8:不装定时任务)

/**
 * retention 策略(工单原文:"每次写后惰性清理(全员 acked 且 >7d,或 >30d TTL)"):
 *  - 硬 TTL:不论是否全员 ack,超过 30 天一律清除(§4.2 默认值)。
 *  - 软 TTL:全体"当前成员"都已 ack 到(或超过)某 seq,且该消息超过 7 天,也清除。
 *    "全员 acked" = cursors 表里每个当前成员都有游标行,且 MIN(acked_seq) >= 该消息 seq;
 *    只要有成员从未调用过 ack(cursors 行数 < members 行数),就不做软 TTL 清理。
 * 只在"每次写后"(append/ack)与"启动时"调用,不跑定时器(D8)。
 */
function cleanupRetention(db: RelayDb, channel: string): void {
  const now = Date.now()
  const hardCutoff = new Date(now - RETENTION_HARD_TTL_MS).toISOString()
  db.raw.prepare('DELETE FROM messages WHERE channel = ? AND ts < ?').run(channel, hardCutoff)

  const memberCountRow = db.raw
    .prepare('SELECT COUNT(*) as c FROM members WHERE channel = ?')
    .get(channel) as {
    c: number
  }
  if (memberCountRow.c === 0) return
  const cursorAgg = db.raw
    .prepare('SELECT COUNT(*) as c, COALESCE(MIN(acked_seq), 0) as m FROM cursors WHERE channel = ?')
    .get(channel) as { c: number; m: number }
  if (cursorAgg.c < memberCountRow.c) return // 还有成员从未 ack 过,不能判定"全员 acked"
  const softCutoff = new Date(now - RETENTION_ACKED_TTL_MS).toISOString()
  db.raw
    .prepare('DELETE FROM messages WHERE channel = ? AND seq <= ? AND ts < ?')
    .run(channel, cursorAgg.m, softCutoff)
}
