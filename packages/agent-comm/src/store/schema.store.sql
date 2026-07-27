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
  -- `name` remains the opaque route identity for compatibility with the original schema.
  name TEXT PRIMARY KEY,
  channel_name TEXT,
  home TEXT NOT NULL,                -- 'local:<abs>' | https URL
  display_name TEXT,
  mode TEXT NOT NULL DEFAULT 'auto', -- auto|intercept|paused(镜像值)
  visibility TEXT NOT NULL DEFAULT 'private', -- private(E2E)|public(plaintext/browser-readable)
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
  runtime_instance_id TEXT,
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

-- Application/client state is independent from transport inbox consumption (D20).
CREATE TABLE IF NOT EXISTS application_runtime_instances (
  runtime_instance_id TEXT PRIMARY KEY,
  profile_principal TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS application_states (
  profile_principal TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  extension_uri TEXT NOT NULL,
  context_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  consumer_version TEXT NOT NULL,
  state_json TEXT NOT NULL,
  task_state TEXT NOT NULL,
  last_event_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_principal, channel_id, extension_uri, context_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_application_states_channel ON application_states(channel_id, task_state);

CREATE TABLE IF NOT EXISTS application_events (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  extension_uri TEXT NOT NULL,
  extension_version TEXT NOT NULL,
  event_type TEXT NOT NULL,
  context_id TEXT,
  task_id TEXT,
  from_alias TEXT NOT NULL,
  event_json TEXT NOT NULL,
  source_runtime_instance_id TEXT,
  processing_runtime_instance_id TEXT NOT NULL,
  status TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  consumer_id TEXT,
  consumer_version TEXT,
  error TEXT,
  original_ts TEXT,
  recorded_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_application_events_context
  ON application_events(channel_id, extension_uri, context_id, recorded_at);

CREATE TABLE IF NOT EXISTS application_effects (
  effect_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES application_events(message_id) ON DELETE CASCADE,
  effect_index INTEGER NOT NULL,
  effect_json TEXT NOT NULL,
  status TEXT NOT NULL,
  runtime_instance_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(message_id, effect_index)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_application_effects_status ON application_effects(status, updated_at);

CREATE TABLE IF NOT EXISTS task_authorizations (
  authorization_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  prompt TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  receipt_json TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_task_authorizations_pending
  ON task_authorizations(channel_id, status, requested_at);

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
  runtime_instance_id TEXT,
  detail TEXT
) STRICT;
