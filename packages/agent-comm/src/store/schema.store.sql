-- 私有 store(每 profile 一份;文件即状态,I5)。所有写在事务内;WAL。
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- 我的身份(单行;私钥在文件,不入库 §4.1)
CREATE TABLE IF NOT EXISTS identity (
  node_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  private_key_ref TEXT NOT NULL,
  relays_json TEXT NOT NULL DEFAULT '[]'
) STRICT;

-- 我加入的频道(镜像;成员表权威在家)
CREATE TABLE IF NOT EXISTS channels (
  name TEXT PRIMARY KEY,
  home TEXT NOT NULL,                -- 'local:<abs>' | https URL
  display_name TEXT,
  mode TEXT NOT NULL DEFAULT 'auto', -- auto|intercept|paused(镜像值)
  description TEXT,
  my_alias TEXT NOT NULL,
  scope_json TEXT,                   -- 兑换邀请授予的 InviteScope
  e2e_key_ref TEXT,                  -- M2:e2eKey 本地引用,不明文入库
  created_at TEXT NOT NULL
) STRICT;

-- 频道成员镜像(list_peers 数据源;含 card,不透明)
CREATE TABLE IF NOT EXISTS peers (
  channel TEXT NOT NULL REFERENCES channels(name) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  node_id TEXT NOT NULL,
  card_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, alias)
) STRICT;

-- 本地消息副本(我发的 + 拉到的)
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  seq INTEGER,                       -- 家赋的全序;成员侧只读(I2)
  from_alias TEXT NOT NULL,
  to_target TEXT NOT NULL,           -- alias | '*'
  trace_id TEXT NOT NULL,
  reply_to TEXT,
  reply_by TEXT,
  hop INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  payload_json TEXT NOT NULL,        -- 不透明(I1);JSON.stringify(payload)
  status TEXT NOT NULL,              -- pending|held|delivered|dropped
  injected_by_human INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL,
  delivered_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages(channel, seq);
CREATE INDEX IF NOT EXISTS idx_messages_trace ON messages(trace_id);

-- 收件箱(单箱,D1):成员关系表;cap 驱逐见 engine
CREATE TABLE IF NOT EXISTS inbox (
  message_id TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_inbox_consumed ON inbox(consumed_at);

-- 每频道与家的同步游标(§2.4)
CREATE TABLE IF NOT EXISTS sync_state (
  channel TEXT PRIMARY KEY REFERENCES channels(name) ON DELETE CASCADE,
  last_seq_synced INTEGER NOT NULL DEFAULT 0
) STRICT;

-- 待上行队列(relay 家断网重试;local 家直写不经此表)
CREATE TABLE IF NOT EXISTS outbox (
  message_id TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
) STRICT;

-- 我铸造的邀请(临时实体 §4.1)
CREATE TABLE IF NOT EXISTS invites_minted (
  link TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  home TEXT NOT NULL,
  scope_json TEXT,
  expires_at TEXT,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;

-- append-only 审计(R9/I6)
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,               -- created|injected|delivered|held|dropped|edited|connected
  message_id TEXT,
  channel TEXT,
  from_alias TEXT,
  to_target TEXT,
  actor TEXT NOT NULL,               -- 'human' | 'agent:<alias>'
  detail TEXT
) STRICT;
