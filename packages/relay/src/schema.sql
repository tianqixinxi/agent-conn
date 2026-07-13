-- relay 自持存储(W4,DESIGN §3 relay 行 / 上游 spec §4.2)。
-- 与 packages/agent-comm/src/store/schema.hub.sql 同构(职责一致:成员表权威、赋 seq、
-- intercept 停消息、邀请兑换、审计),按 relay 自身需要加了列(head_seq/join_seq,破冰限流用)。
-- 本文件是 relay 包私有 schema,不与 agent-comm 共享代码(信任边界:relay 只依赖 protocol)。
--
-- 并发模型:单进程单 DatabaseSync 连接,同步调用 + Node 单线程事件循环,天然串行化;
-- 多语句写仍用显式 BEGIN/COMMIT 包事务(见 store.ts),为的是崩溃一致性而非并发控制。
-- WAL 由 store.ts 按 dbPath 是否为 ':memory:' 决定是否开启(内存库不支持 WAL,PRAGMA 会被
-- SQLite 静默忽略并退化为 memory journal,这里不建 PRAGMA 语句以保持 schema 与连接设置分离)。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS channels (
  name TEXT PRIMARY KEY,
  display_name TEXT,
  mode TEXT NOT NULL DEFAULT 'auto',    -- auto|intercept|paused;门在家(§2.2)
  description TEXT,
  -- 本频道累计分配过的最大 seq。独立于 messages 表存在,是为了让 retention 清理(删旧消息)
  -- 不影响 seq 单调性与 GetMessagesRespSchema.head 的正确性(否则频道被清空后 MAX(seq) 会归零)。
  head_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;

-- 成员表:from 盖戳与鉴权(nodeId→publicKey)的依据(§2.3);
-- join_seq = 加入时的 channel.head_seq 快照,破冰限流(D3.2)据此判断"加入后"的消息范围。
CREATE TABLE IF NOT EXISTS members (
  channel TEXT NOT NULL REFERENCES channels(name) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  node_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  scope_json TEXT,
  card_json TEXT,
  joined_at TEXT NOT NULL,
  join_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, alias)
) STRICT;
-- 频道内按 nodeId 查成员(from 盖戳、幂等 join 判断)
CREATE INDEX IF NOT EXISTS idx_members_channel_node ON members(channel, node_id);
-- 跨频道按 nodeId 查任一已注册公钥(鉴权中间件:节点未必是"这个"频道的成员,但可能在别的频道注册过)
CREATE INDEX IF NOT EXISTS idx_members_node ON members(node_id);

-- 频道日志:seq 在 (channel) 内单调(I2);envelope 原样存(I1,payload 不透明)。
-- from_alias 从 envelope_json 冗余出来一列,供破冰计数 / from 盖戳判断走索引,不算解析 payload。
CREATE TABLE IF NOT EXISTS messages (
  channel TEXT NOT NULL REFERENCES channels(name) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  from_alias TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  status TEXT NOT NULL,                 -- pending|held|delivered|dropped
  ts TEXT NOT NULL,
  -- held 消息的处置人;M2 relay wire 契约暂无"释放 held 消息"端点(见汇报的契约问题),
  -- 此列先按 hub schema 同构建出,当前无写入路径。
  decided_by TEXT,
  PRIMARY KEY (channel, seq)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_mid ON messages(channel, message_id);
-- 破冰计数 / 长轮询拉取都按 (channel, seq) 范围 + from_alias 过滤
CREATE INDEX IF NOT EXISTS idx_messages_channel_seq_from ON messages(channel, seq, from_alias);

CREATE TABLE IF NOT EXISTS cursors (
  channel TEXT NOT NULL,
  node_id TEXT NOT NULL,
  acked_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, node_id)
) STRICT;

-- 邀请兑换态:只存 token 哈希(sha256 hex),与 hub 同构(§4.2),永不见明文 joinToken。
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  channel TEXT NOT NULL REFERENCES channels(name) ON DELETE CASCADE,
  scope_json TEXT,
  expires_at TEXT,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_by_node TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,                  -- connected|held|delivered|edited(§I6 子集,详见 store.ts 注释)
  message_id TEXT,
  channel TEXT,
  from_alias TEXT,
  to_target TEXT,
  actor TEXT NOT NULL,                  -- 'human' | 'agent:<alias>'(I4/I6)
  detail TEXT
) STRICT;
