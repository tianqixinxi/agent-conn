-- local hub(D5):local: 频道的家 = 本机共享 SQLite 文件。
-- 职责与 relay 完全同构:成员表权威、赋 seq、intercept 停消息、邀请兑换、审计。
-- 并发:多进程直写,SQLite 锁串行化;busy_timeout 由连接方设置。
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS hub_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS hub_channels (
  name TEXT PRIMARY KEY,
  display_name TEXT,
  mode TEXT NOT NULL DEFAULT 'auto',   -- auto|intercept|paused;门在家(§2.2)
  description TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS hub_members (
  channel TEXT NOT NULL REFERENCES hub_channels(name) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  node_id TEXT NOT NULL,
  public_key TEXT,                     -- local 家不验签(文件 ACL 即边界),仍存档
  scope_json TEXT,
  card_json TEXT,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (channel, alias)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_hub_members_node ON hub_members(channel, node_id);

-- 频道日志:seq 在 (channel) 内单调(I2);envelope 原样存(I1)
CREATE TABLE IF NOT EXISTS hub_messages (
  channel TEXT NOT NULL REFERENCES hub_channels(name) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  status TEXT NOT NULL,                -- pending|held|delivered|dropped
  ts TEXT NOT NULL,
  decided_by TEXT,                     -- held 消息的处置人(audit 冗余)
  PRIMARY KEY (channel, seq)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_messages_mid ON hub_messages(channel, message_id);

CREATE TABLE IF NOT EXISTS hub_cursors (
  channel TEXT NOT NULL,
  node_id TEXT NOT NULL,
  acked_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, node_id)
) STRICT;

-- 邀请兑换态:只存 token 哈希(sha256 hex),与 relay 同构(§4.2)
CREATE TABLE IF NOT EXISTS hub_invites (
  token_hash TEXT PRIMARY KEY,
  channel TEXT NOT NULL REFERENCES hub_channels(name) ON DELETE CASCADE,
  scope_json TEXT,
  expires_at TEXT,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  created_by_node TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS hub_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,
  message_id TEXT,
  channel TEXT,
  from_alias TEXT,
  to_target TEXT,
  actor TEXT NOT NULL,
  detail TEXT
) STRICT;
