# 决议记录(agent-comm 实现)

> 本文件是公开的实现决议记录。历史 R/S/C 与章节编号来自项目早期需求稿；当前可执行契约以 `DESIGN.md`、协议 schema、测试和本文件为准。
> 本文件记录实现方对设计的**拍板、偏离与细化**。硬约束 C1–C5 不可违背，本文所有决议均在其内。
> 状态:D1–D13 已拍板(2026-07-14)。

## D1 身份锚定:NodeIdentity/profile,session 降级为 presence

**决定**:身份(成员资格、收件箱归属)锚定到 **profile**(= 一份本地 store + 一份 NodeIdentity keypair)。默认一台机器一个 profile(`default`);`--profile <name>` / `AGENT_COMM_PROFILE` 可手动分身。session 不再是身份:仅作 presence(在线判定、通知路由)与审计线索(记入 `AuditEntry.detail`)。

**Schema 影响**(相对 spec §3.2):
- `ChannelMember { alias, nodeId, joinedAt }` —— `sessionId` 字段删除,与 relay 侧成员表(§4.2 `channel ↔ (alias, nodeId, pubkey)`)对齐。
- `Peer.sessionId` → `Peer.nodeId`。
- `Inbox` 不再按 sessionId 分裂:**每 store 一个收件箱**,`read_inbox` 的 filter(channel/traceId/contentType)负责细分。
- `whoami` 返回 `{ nodeId, profile, memberships }`,不再依赖宿主注入 session id(宿主对 stdio MCP 子进程传 session id 无保证)。

**理由**:session 短命,锚 session 打穿 R3/S1(spec §3.2 与 §4.2 原本就互相矛盾);EigenFlux 生产教训佐证(身份=home 目录,且 home 严禁从 cwd 派生——Codex 每 task 换 cwd 会每 task 铸新身份)。见 `eigenflux-comparison.md` §4.1。**profile 严禁从 cwd 自动派生**,按项目分身必须显式 `--profile`。

## D2 E2E 与托管审批的矛盾:审批走明文侧信道

**决定**:托管审批服务(§7.2)若读取 action/args，就不能假装是 E2E relay 的一部分。托管请求应由请求方节点直接调用独立审批 API，频道只流转决定引用；落地在 M3。

**D10 后澄清**：Claude Channel 的高层 `request_approval` 是 A2A `AUTH_REQUIRED`，面向对端 runtime/用户，内容正常走 E2E 频道；它不是上述托管审批服务。两个概念共享“approval”一词，但信任边界不同。

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
- 明确推迟:组密钥轮换、contentType 治理、L1 版本协商、NATS/SLIM adapter。

## D7 命名与发布

产品/二进制名 `agent-comm`，包名 `@agent-comm/*`。源码仓库按 Apache-2.0 开放；workspace 包继续保留 `private: true`，直到 npm 发布流程、scope 所有权和供应链签名准备完成，防止误发布。

## D8 安装边界(来自 EigenFlux 反例)

`join`/安装流程**绝不**:写入宿主/agent 的持久指令文件、创建 cron/launchd/定时任务、要求常驻进程。C5 拉基线保证功能完整;引导页与链接只携带连接数据(R10 原文重申)。

## D9 集成收口裁决(W1–W4 上报问题的处置,2026-07-13)

1. **`POST /ch/:c/create` 转正**:W4 的 bootstrap 建频道端点回填进 `protocol/wire.ts`(`postCreate` + schema,含 description);W3 驱动的 `createChannel` 已接线。访问控制(任何持钥节点可建频道)暂不限制,归 relay 部署方/§9.6 反滥用。
2. **held 与游标语义**:`head` 的契约语义定为「游标可安全推进位」,不得越过未决 held(W1 的 local 家已如此)。relay v1 无放行端点暂不违约;**M3 远程门必须二选一**:放行即重新赋 seq,或与 local 家同样停 head。已写进 wire.ts 注释。
3. **`HomeDriver.join` 的 channel 入参**降级为 optional(两种家都由 joinToken 反查权威频道名);T3 只读方法(listHeld/auditQuery)不带 actor 属预期——它们的门是「不在 MCP 工具面」,api.ts 注释已修正。
4. **listPeers 拉基线修复**(集成时发现的真 bug):返回前先从家刷新成员镜像,家不可达降级用旧镜像。
5. **审计视角**:每个 store 的账本记本节点视角(发送方记 created/injected+held,治理方记 delivered/dropped);频道级权威账在家(hub_audit/relay audit)。跨账本合并查询留 M3。
6. **M2 前置清单**(工单交付明确不含,集成时确认未做):relay 侧 scope(canSendTo/contentTypes)在 append 时强制;relay 摄入时强制 replyBy 过期;engine 的 signRequest 接线(crypto.signCanonical);E2E 密钥落盘(keys/<channel>.key + e2e_key_ref)与 withE2e 接线;`agent-comm relay` 的 joinToken↔完整链接拼装。
7. **保留 W4 自加的防御规则**:同一 (channel, nodeId) 不得注册两个 alias(409 CONFLICT)——`from` 盖戳需要 nodeId→alias 良定义;批量上行破冰限流按整批判断(现 schema 无部分失败表达,不改)。

## D10 应用协议采用 A2A 1.0，不再维护私有 intent 协议（2026-07-14）

**决定**：AgentCard、Message、Task、Part、Artifact 与任务状态以 A2A 1.0 为 canonical model。AgentComm 的 `intent/context` 只是 A2A Message data part 的一种便捷内容，不再是另一套 wire protocol。新委派、回复、缺输入、缺授权和完成状态全部经官方 A2A 类型与 codec 序列化。

**兼容**：旧 opaque JSON 继续按 legacy user work 接收；transport 不解析新旧 payload。官方 JS SDK 目前是 1.0 beta，所有耦合集中在 `protocol/src/a2a.ts`，避免 beta API 扩散。

**理由**：A2A 已经定义跨 runtime 协作所需的公共语义；Agency Swarm 一类方案解决的是进程内 orchestration，不应拿来当跨 runtime transport 或任务 wire model。

## D11 语义与 transport 解耦，NATS 是稳定目标，SLIM 延后

**决定**：`HomeDriver` 重构为 `TransportBinding`，由有序 factory registry 按 home URL 选择。内置 local SQLite 与 HTTP relay；`nats://` 和 `slim://` 已进入 schema 与 factory contract，但没有 adapter 时 fail closed 为 `NOT_IMPLEMENTED`。

**选型**：NATS JetStream 是下一阶段稳定 transport 目标；AGNTCY SLIM 保留为后续安全互操作 binding，等 Node binding 的 API、发布与运维模型成熟后接入。不会因为 transport 选型而改变 A2A task lifecycle、邀请 UX 或 E2E 层。

## D12 runtime 面只暴露一个高层工具

**决定**：Claude Channel 只注册 `agent_comm`，操作是 `share/connect/delegate/reply/complete/request_input/request_approval/resolve_approval`。poll、sync、cursor、ACK、publish_card、加解密和 transport 参数不作为独立工具暴露。

**通知策略**：普通消息和 task 更新主动推入 runtime 自动处理；`INPUT_REQUIRED` 先由 runtime 补全；只有 `AUTH_REQUIRED`、transport-held 或宿主原生权限门需要通知用户。事件直到高层操作成功后才 ACK，维持 at-least-once。

## D13 标准 HTTP 互操作是入口，不替代私密频道

**决定**：relay 可选择提供 A2A AgentCard discovery 和 HTTP+JSON async `message:send`。AgentComm 私密频道路由放在声明为 required 的 A2A extension metadata 中，请求仍需节点签名。store-and-forward relay 只接受 `returnImmediately=true`；当前不声明 stream、task query/cancel 或标准 push notification 能力。

**安全边界**：标准 JSON gateway 会看到 message parts，所以默认关闭，只能在信任 relay 的部署中用 `AGENT_COMM_A2A_INGRESS=1` 开启；原生 AgentComm E2E endpoint 不受影响。未来要做 E2E 标准 ingress，应放在持频道密钥的 runtime gateway。能力卡必须反映当前真实实现，不能把内部轮询写成标准 streaming/push 支持。

## D14 Channel 注册与 connect 审批由宿主强制（2026-07-14）

**决定**：当前本地开发入口用 `--plugin-dir` 直接加载目录，并没有把 marketplace entry 安装进 Claude，因此 development channel 必须写成 `server:agent-comm`。写成 `plugin:agent-comm@agent-comm-local` 会显示 `plugin not installed`：MCP 工具仍可能由 `--plugin-dir` 出现，但 Channel listener 不会绑定到该未安装的 plugin entry。根目录 `.mcp.json` 同时会被当作项目配置读取，此时 Claude 不自动提供插件专用变量，所以 launcher 还必须显式设置 `CLAUDE_PLUGIN_ROOT=<repo>`；否则 `/mcp` 会显示 `Missing environment variables: CLAUDE_PLUGIN_ROOT` 且 server 为 failed。未来通过 marketplace 安装后才改用 `plugin:<name>@<marketplace>`，也不再需要这项本地开发注入。

浏览器启动失败的另一根因是 `--dangerously-load-development-channels` 为 variadic 参数；邀请 prompt 放在它后面会被解析成未加 `server:`/`plugin:` 标签的第二个条目。launcher 必须先放 prompt，再放该参数，并让 development channel entry 成为命令尾项。

`connect` 不再依赖 runtime instructions 自觉询问。插件随包提供 `PreToolUse` hook，仅在 `agent_comm(operation=connect)` 时返回 `permissionDecision=ask`；其余已建立信任后的高层操作不被打断。用户显式选择 bypass permissions 或管理员禁用插件 hook 仍属于宿主策略覆盖，不伪装成协议层保证。

## D15 可见性、公开阅读与插件发布（2026-07-16）

**频道可见性**：`private` 是默认值，远程消息继续 AES-256-GCM E2E；`public` 必须在创建时明确选择，不生成或接受 E2E key，relay 可通过 `/public/<channel>` 与 `/api/public/channels/...` 展示已放行消息。visibility 不支持原地切换，防止历史私密消息因配置变更泄漏。公开读取不授予成员资格或写权限，写入仍要求节点签名和频道成员身份。

**插件发布**：仓库根目录是公开 marketplace，实际安装源是自包含的 `plugin/`，其中包含构建后的 runtime、MCP 配置、Channel 声明和 connect 审批 hook。CI 必须执行官方 `claude plugin validate` 并验证已提交产物可复现。`v*` release 在 Relay 部署成功后创建带 checksum 的 GitHub Release。Anthropic 官方 marketplace 的收录必须通过官方表单审核，pipeline 不伪装成能够自动批准第三方上架。
