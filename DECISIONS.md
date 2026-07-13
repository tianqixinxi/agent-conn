# 决议记录(agent-comm 实现)

> 上游需求与设计基准:`../meee2-workspace/doc/prd/agent-comm-requirements-handoff.md`(R/S/C 编号出处)与 `agent-comm-mcp-spec.md`(§ 编号出处)。
> 本文件记录实现方对 spec 的**拍板、偏离与细化**。硬约束 C1–C5 不可违背,本文所有决议均在其内。
> 状态:D1–D8 已拍板(2026-07-13)。

## D1 身份锚定:NodeIdentity/profile,session 降级为 presence

**决定**:身份(成员资格、收件箱归属)锚定到 **profile**(= 一份本地 store + 一份 NodeIdentity keypair)。默认一台机器一个 profile(`default`);`--profile <name>` / `AGENT_COMM_PROFILE` 可手动分身。session 不再是身份:仅作 presence(在线判定、通知路由)与审计线索(记入 `AuditEntry.detail`)。

**Schema 影响**(相对 spec §3.2):
- `ChannelMember { alias, nodeId, joinedAt }` —— `sessionId` 字段删除,与 relay 侧成员表(§4.2 `channel ↔ (alias, nodeId, pubkey)`)对齐。
- `Peer.sessionId` → `Peer.nodeId`。
- `Inbox` 不再按 sessionId 分裂:**每 store 一个收件箱**,`read_inbox` 的 filter(channel/traceId/contentType)负责细分。
- `whoami` 返回 `{ nodeId, profile, memberships }`,不再依赖宿主注入 session id(宿主对 stdio MCP 子进程传 session id 无保证)。

**理由**:session 短命,锚 session 打穿 R3/S1(spec §3.2 与 §4.2 原本就互相矛盾);EigenFlux 生产教训佐证(身份=home 目录,且 home 严禁从 cwd 派生——Codex 每 task 换 cwd 会每 task 铸新身份)。见 `eigenflux-comparison.md` §4.1。**profile 严禁从 cwd 自动派生**,按项目分身必须显式 `--profile`。

## D2 E2E 与托管审批的矛盾:审批走明文侧信道

**决定**:`request_approval` 走 E2E 频道时,托管审批服务(§7.2)**读不到 action/args**(§2.5 relay 无明文),两者矛盾。解法:托管审批请求**不经频道消息**,由请求方节点直接以明文调用审批服务的独立 API(审批内容本来就是给已认证的人看的);频道内只流转 `approval_decision` 结果引用。会话内 elicitation 路径(§7.1)不受影响。E2E 频道的「relay 无明文」保证不被破坏。落地在 M3。

## D3 T1/T2 落地方式 + 删除「send 跨信任域首发 T2」

**决定**:
1. T1/T2 三档(§6)在 MCP 协议层**无强制手段**,落地为宿主配置纪律:随包分发推荐 `permissions.allow` 清单(仅 T1 工具),T2 工具永不进 allowlist、靠宿主默认弹窗。威胁模型文档须写明这是「宿主配置纪律」而非硬保证。
2. **删除** spec §5 中 `send` 的「跨信任域首发 = T2」条款:`join`/`connect` 已是人工门,入频道后所有 send 均 T1。首发滥用改由 relay 侧限流兜底(M2,破冰式:对方未回复前发起方限 N 条,参考 EigenFlux ice-break),同时解决 §9.6 反滥用的一部分。

## D4 技术栈

TypeScript / Node ≥ 22(实测 Node 24),**`node:sqlite`**(零原生依赖,npx 秒装;WAL)。官方 `@modelcontextprotocol/sdk`(stdio server + elicitation)。Zod(schema,spec §3 建议)。CLI 用 commander。relay 用 Hono + `@hono/node-server` + `node:sqlite`。构建 tsup,测试 vitest,lint/format 用 biome,pnpm workspaces。crypto 全用 Node 内建(Ed25519 身份签名,AES-256-GCM E2E)——**全链路零原生依赖**。

## D5 local 频道家泛化:共享 hub 文件,拉取为唯一投递模型

**决定**:`Channel.home` 取值 `local:<绝对路径>` | `<relayUrl>`。local 家 = 一个**共享 SQLite 文件**(默认 `~/.agent-comm/local-hub.db`,机器级),持频道日志、赋 `seq`、停 intercept 消息——与 relay 家职责完全同构(§2.2 一频道一家不变)。成员从家**拉取**(游标 + messageId 去重)进自己 store 的收件箱;`read_inbox` 顺带 sync 一轮(§2.6 拉基线)。同机邀请链接形如 `agentcomm-local:?path=...&t=<token>`,不出网。

**理由**:D1 之后「一 store = 一身份」,spec §2.1 的「共享 SQLite = 本地总线」不再天然成立(两个 profile 是两个 store)。把 local 家做成共享文件后,R1(同机零基建)在多身份下依然成立,且 local/relay 走**同一套 sync 抽象**(仅 driver 不同:文件直读 vs HTTPS),投递语义统一为 at-least-once + 去重 + 家内全序。

## D6 里程碑

- **M1 本机总线**:store/engine/local-home + MCP 12 工具 + CLI(init/join/invite/T3 治理)+ intercept→elicitation。验收:同机 3 个 profile 跑通 S2 式日报 demo(脚本化)。
- **M2 跨机**:relay server + sync client + E2E + connect-by-link + `npx agent-comm join` 引导安装(R10)+ relay 限流(D3.2)。验收:S1 双机交接。
- **M3 审批与加固**:托管审批服务(D2,签名决定/验签)+ per-sender 签名评估 + daemon 加速器(可选)+ 密钥轮换方案。验收:S3。
- 明确推迟:组密钥轮换、contentType 治理、L1 版本协商、marketplace(永不做)。

## D7 命名与发布

产品/二进制名 `agent-comm`,包名 `@agent-comm/*`(npm registry 实名到 M2 发布时定,可能需换 scope)。仓库目录 `agent_connect` 为工作名。全包 `private: true` 直到 M2。

## D8 安装边界(来自 EigenFlux 反例)

`join`/安装流程**绝不**:写入宿主/agent 的持久指令文件、创建 cron/launchd/定时任务、要求常驻进程。C5 拉基线保证功能完整;引导页与链接只携带连接数据(R10 原文重申)。
