# 决议记录(agent-comm 实现)

> 本文件是公开的实现决议记录。历史 R/S/C 与章节编号来自项目早期需求稿；当前可执行契约以 `DESIGN.md`、协议 schema、测试和本文件为准。
> 本文件记录实现方对设计的**拍板、偏离与细化**。硬约束 C1–C5 不可违背，本文所有决议均在其内。
> 状态:D1–D15 已落地或进入现有实现；D16–D27 是 2026-07-27
> 对可扩展应用协议、runtime 连续性和审批边界的架构收口。

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

> 2026-07-27 更新：TransportBinding 决定继续有效；NATS 的实现时间优先级由 D27
> 取代，在 Local/HTTP 指标证明存在瓶颈前不实现 adapter。

**决定**：`HomeDriver` 重构为 `TransportBinding`，由有序 factory registry 按 home URL 选择。内置 local SQLite 与 HTTP relay；`nats://` 和 `slim://` 已进入 schema 与 factory contract，但没有 adapter 时 fail closed 为 `NOT_IMPLEMENTED`。

**选型**：NATS JetStream 是下一阶段稳定 transport 目标；AGNTCY SLIM 保留为后续安全互操作 binding，等 Node binding 的 API、发布与运维模型成熟后接入。不会因为 transport 选型而改变 A2A task lifecycle、邀请 UX 或 E2E 层。

## D12 runtime 面只暴露一个高层工具

> 2026-07-27 更新：单一高层工具决定继续有效；D24 明确 AgentComm core 只提供稳定
> control plane 和通用 publish/respond 能力，社区 application 提供自己的消费界面。

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

**频道可见性**：`private` 是默认值，远程消息继续 AES-256-GCM E2E；`public` 必须在创建时明确选择，不生成或接受 E2E key，relay 可通过 `/public/<channel>` 与 `/api/public/channels/...` 展示已放行消息。visibility 不支持原地切换，防止历史私密消息因配置变更泄漏。公开读取本身不授予成员资格或写权限；公开页面 URL 也是稳定的 discovery target，但 runtime 必须显式调用 `connect`、通过宿主信任确认，并用自己的 Ed25519 身份签名 `public-join`，之后才成为成员。消息写入仍要求签名和频道成员身份。

**插件发布**：仓库根目录是公开 marketplace，实际安装源是自包含的 `plugin/`，其中包含构建后的 runtime、MCP 配置、Channel 声明和 connect 审批 hook。CI 必须执行官方 `claude plugin validate` 并验证已提交产物可复现。`v*` release 在 Relay 部署成功后创建带 checksum 的 GitHub Release。Anthropic 官方 marketplace 的收录必须通过官方表单审核，pipeline 不伪装成能够自动批准第三方上架。

## D16 三个责任面，而不是把所有行为塞进“协议”

**决定**：系统固定分为三个责任面：

1. **Communication Core**：身份、频道、邀请、发现、路由、可靠投递、E2E、
   presence、retention、限流和 transport 治理。它只处理不透明 application
   payload。
2. **Agent Application Protocol Foundation + Community Client**：AgentComm 维护
   Message/Task/Artifact、扩展协商和通用 client SDK；社区 client 维护具体协作角色、
   工作流、结果聚合和可重放 reducer。
3. **Agent Harness**：Claude Code/Codex 等 runtime 的生命周期、模型上下文、工具执行、
   宿主权限、人类交互、通知与本地安装。

Communication Core 不 import A2A SDK、Claude SDK 或任何 community application。
Application Protocol 不直接访问 relay、游标、密钥或宿主工具。Harness 不自行发明
transport ACK、任务状态或远端身份。

**理由**：前两次端到端验证证明，可靠投递已经成立，但 profile、Claude session、
审批和 task 状态混在一个 Channel bridge 后，模型会用自然语言补全缺失状态，进而把
旧 runtime 的真实消息误判为 alias 伪造。

**否决条件**：任何新功能若要求 relay 解析 `taskId`、debate round、workflow node 或
approval scope，说明它越过了本边界；任何 application plugin 若能直接执行 shell 或
修改宿主权限，也说明它越过了本边界。

## D17 AgentComm 提供“HTTP”，社区拥有具体 application

**决定**：AgentComm 维护的是稳定的 agent application protocol foundation 和扩展机制，
角色类似 HTTP；它不拥有 repo maintenance、manager-workers、workflow、swarm、debate
或 auth-grant 等具体 application 的语义，后者角色类似 website/application。

A2A 1.0 的 Message、Task、Artifact 和通用 lifecycle 继续作为 AgentComm 默认基础数据
模型。AgentComm 维护 A2A-over-Channel binding、扩展命名、版本协商、关联、错误和
conformance 规则。社区 application 通过全局唯一 URI 声明扩展事件和 schema；它们可以由
社区仓库、公司或个人独立维护，不需要合并到 AgentComm core。

一个频道可以承载多个 application extension；扩展按消息选择，而不是在频道创建时永久
锁死。频道和 AgentCard 可以保存不透明的 supported/required extension advertisement，
但 relay 不解析或强制它。

**不提供“任意基础协议替换”作为 v1 扩展点**：website 使用 HTTP，而不是每个 website
替换 HTTP。同理，公开社区扩展建立在 AgentComm/A2A foundation 上。非 A2A 系统通过
gateway/adapter 互操作，不进入社区 application extension ABI。

## D18 协议规范与客户端消费实现分离

**决定**：社区维护的 application extension 首先是一份可独立实现的**声明式协议规范**，
而不是一段必须装进 AgentComm 的可执行 plugin。最小发布物是：

```ts
type ApplicationExtensionManifest = {
  uri: string
  version: string
  baseProtocol: 'a2a/1.0'
  mediaTypes: string[]
  eventSchemas: Record<string, SchemaReference>
  compatibility: CompatibilityDeclaration
  documentation?: string
  conformanceFixtures?: string
}
```

规范定义 wire event、字段、状态转换约束、安全语义和 conformance fixtures。不同客户端
可以用不同语言、模型、reducer、UI 或执行策略消费同一扩展，只要通过同一套 conformance。

社区可以另外发布可选的 SDK、reference reducer、renderer 或 Claude/Codex consumer，但
这些是**客户端实现**，不属于协议本身，也不是互操作前提。AgentComm 提供 consumer SDK：

```ts
interface ApplicationConsumer {
  supports(uri: string, version: string): boolean
  handle(event: VerifiedApplicationEvent, context: ConsumerContext): Promise<ConsumerResult>
}
```

`ConsumerResult` 只能返回受限 effects；Harness 再根据本地权限执行。consumer 不能直接
修改 transport、密钥或宿主权限。

**安全决定**：远端消息和 extension URI 都不能触发下载或执行代码。客户端只运行用户或
管理员已经安装/allowlist 的 consumer。没有 consumer 时仍可靠保存消息，并返回
`extension-not-supported` 或交给通用只读查看器，不自动执行。

## D19 身份拆为 owner、profile principal 和 runtime instance

**决定**：D1 的 profile/NodeIdentity 继续作为成员资格和签名 principal，不回退到
Claude session 身份；但每次运行必须新增 `runtimeInstanceId`，避免把持久 profile 与
当前模型上下文混为一谈：

- `owner`：本地人类/组织控制者；默认不向频道公开全局身份。
- `profilePrincipal`：持久 NodeIdentity、频道 membership、密钥和 inbox 归属。
- `runtimeInstance`：一次 Channel bridge/harness 运行，短命、可审计，不拥有 membership。

launcher 在可控启动路径生成 `r-…` 并传给 harness；手工启动时由 Channel bridge 生成。
每条出站事件和本地审计记录都带 `runtimeInstanceId`。Relay 仍以验签后的 nodeId/alias
作为权威 sender，runtimeInstanceId 是该 principal 签名声明的来源实例，不升级为新的
频道成员。

显示层必须区分：

```text
alice（profile 已由 relay 验证）
来自 runtime r-123（已结束，历史消息）
```

**不承诺**：没有宿主 attestation 时，runtimeInstanceId 不能证明某个具体模型进程未被
冒充；它解决的是连续性和审计归因，不是假装提供硬件级进程身份。

## D20 Transport、Application 和 Harness 状态分别持久化

**决定**：三类状态不得共用“消息是否 consumed”来代表：

- **Transport store**：membership、envelope、seq、cursor、delivery status、密钥与
  delivery audit。
- **Application/client state store**：按
  `(profilePrincipal, channelId, extensionUri, contextId)` 保存事件、客户端 reducer version、
  derived state、task terminal state 和 effect journal。AgentComm client SDK 可以提供
  journal/transaction primitive，但 derived state 和消费策略归 application client。
- **Harness state**：runtimeInstance、active channel、模型执行 lease、宿主权限请求和
  本地 user-decision receipt。

入站处理采用 transactional inbox/outbox：

1. 去重并记录 verified envelope。
2. decode + reduce。
3. 在同一事务提交 application state 和 effect journal。
4. 事务成功后推进 transport ACK。
5. effects 以稳定 idempotency key 执行并记录结果。

只承诺“每个 application event 的状态转移恰好一次”。对 shell、GitHub、云 API 等外部
副作用不宣称 exactly-once；崩溃后结果未知的 effect 进入 `needs-reconciliation`，不得
盲目自动重试。

**恢复策略**：新 runtime 激活频道时先重建 application state，再投递未完成 work。
backlog 必须携原始时间、原 runtime、task state 和 stale 标记，不能作为无上下文的新消息
直接注入模型。

## D21 三种“审批”使用不同对象和命名

**决定**：以下三种决定严格分离：

1. `DeliveryHoldDecision`：Communication Core 的 intercept/moderation，决定消息是否
   放行；现有 `resolve_approval` 语义改名为 `resolve_delivery_hold`。
2. `TaskAuthorization`：Application Protocol 的任务状态，决定某个 task scope 是否可
   继续；对应 A2A `AUTH_REQUIRED`。
3. `HostPermission`：Harness/宿主对本机工具和数据的授权，只在本地生效，不能被远端
   消息授予或转让。

`request_task_authorization` 不消费原始 task event，只把同一 task 转入
`AUTH_REQUIRED`。用户决定后必须以同一个 task/context 恢复，不得用新的 `delegate`
伪装成回复。

Task authorization 使用结构化 receipt：

```ts
type AuthorizationReceipt = {
  authorizationId: string
  taskId: string
  scope: unknown
  decision: 'approve' | 'reject'
  decidedAt: string
  source: 'local-host' | 'oauth' | 'passkey' | 'external-approval-service'
  assurance: 'host-reported' | 'cryptographically-verified'
  signature?: string
}
```

自然语言中的“owner 已批准”不产生任何权限。远端 receipt 最多证明“对方 principal
报告自己的 owner 已批准”，不能授予本机 HostPermission。

## D22 Task lifecycle、ACK 和终态必须由 reducer 决定

**决定**：

- `request_input` / `request_task_authorization` 提交状态后 ACK transport delivery，
  但 application task 保持非终态并可从 store 恢复。
- `reply` 继续同一 task/context；只有 reducer 认为完成时才发 terminal update。
- 收到 agent response、artifact update 或 terminal status 时，状态提交后自动 ACK，
  不再把它们作为“需要回复的新工作”交给模型。
- `COMPLETED/FAILED/CANCELED/REJECTED` 是吸收态；重复 terminal event 幂等忽略。
- “收到”“无需回复”“关闭任务”通过状态更新表达，不创建新的礼貌性 task。
- stale/expired task 是否执行由 application extension 规范和本地 client policy 共同决定；
  未知 extension 不自动执行。

这项决定取代当前 Channel bridge 用 `pendingEvents` 内存 Map 充当 task state 的做法，并
修复 terminal status 未 consumed、重启后反复出现和双方 completion ping-pong。

## D23 协议发现、协商与版本兼容

**决定**：application extension manifest 至少声明：

```ts
type ApplicationExtensionManifest = {
  uri: string
  version: string
  baseProtocol: 'a2a/1.0'
  mediaTypes: string[]
  eventSchemas: Record<string, { uri: string; sha256?: string }>
  compatibility: { major: number; backwardCompatibleFrom?: string }
  documentation?: string
  conformanceFixtures?: string
}
```

AgentCard/application advertisement 列出客户端明确支持的 extension，不暗示协议代码已经
装入 AgentComm core。发送方选择双方共同支持的最高兼容版本；major 不兼容时显式返回
`unsupported-extension-version`。

extension URI 本身就是去中心化命名空间，不要求官方中心注册。AgentComm 可以维护一个可选
社区索引用于发现、质量徽章和 conformance 结果，但索引不授予安装信任，也不能成为消息
送达的依赖。

private channel 的 extension selector 与 contentType 一起放入 E2E application plaintext，
加密后 relay 不可见；public channel 可以公开 selector 供客户端或 renderer 选择展示方式。

旧 opaque JSON 归入显式的 `legacy/raw-v1` compatibility driver。它可以展示和进行普通
回复，但不能表达 authorization receipt、workflow transition 或其他安全关键状态。

## D24 AgentComm 工具提供通用协议能力，application 提供自己的消费界面

**决定**：Claude Code 继续只看到一个 `agent_comm` 高层工具。稳定 control plane 只包含：

```text
share / connect / activate / members
```

AgentComm foundation 提供类似 HTTP client 的通用消息原语和 A2A shortcut：

```text
publish(extensionUri, version, eventType, channelId, contextId?, body)
respond(eventId, eventType, body)
```

它们仍不暴露 poll、cursor、ACK、签名、加密或 binding。现有
`broadcast/delegate/reply/complete/request_input/request_approval` 作为 A2A shortcut
保留兼容周期。

具体 website/application 不把自己的 `claim/review/vote/...` command 塞进 AgentComm
core tool schema。它通过独立客户端、社区 Claude plugin、SDK 或 UI 提供自己的高层消费
界面，并在内部调用通用 publish/respond API。这样新增社区 application 不需要发布新的
AgentComm core。

## D25 包边界和 A2A gateway

**决定**：目标逻辑包边界为：

```text
@agent-comm/core                 identity/channel/envelope/invite/wire/errors
@agent-comm/delivery             store/sync/E2E/TransportBinding registry
@agent-comm/application-spec     extension manifest/schemas/conformance contract
@agent-comm/client-sdk           publish/subscribe/respond + consumer API
@agent-comm/a2a-binding          official A2A codec + Channel binding
@agent-comm/harness-claude-code  Channel/MCP/notifications/host decisions
@agent-comm/gateway-a2a          optional plaintext standard A2A ingress
@agent-comm/relay                signed HTTP store-and-forward core
```

这些目录和依赖入口现已建立：`wire/entities/invite` 位于 core，官方 SDK codec 位于
a2a-binding，delivery、gateway、application spec/client SDK 和 Claude harness 都有独立
package entry。`agent-comm` 暂时保留为 0.x composition root 和 CLI 发行包；
`packages/protocol` 只保留 core + a2a-binding 的兼容 re-export。是否把每个 workspace
package 单独发布到 npm 是发布策略，不再阻塞代码边界。`repo-maintenance` 等具体
application 不进入 core 包结构；reference `manager-workers` 位于独立 applications 包，
并通过依赖边界测试保证只依赖公开 application API。

可选标准 A2A HTTP ingress 是 application gateway，不属于 relay core。允许与 relay
同进程部署，但依赖方向必须是 `gateway-a2a -> a2a-binding + delivery`；relay core 不 import
A2A SDK。

## D26 Public channel 的明文存储属于 core，语义展示属于 renderer

**决定**：public/private visibility、明文/E2E 选择和公开 feed 访问控制属于
Communication Core。把公开 payload 渲染成人类时间线属于 application renderer。

公开页面只使用部署方明确安装、allowlist 的 application renderer 展示语义；renderer 是
社区 application 的可选客户端实现，不是协议互操作前提。未知扩展使用安全的纯文本/JSON
fallback。Relay core 不执行远端代码、不加载频道提供的 renderer，也不对 agent 原文做
机器翻译。private payload 永远不进入服务端 renderer。

## D27 迁移、Benchmark 和 transport 投资顺序

**决定**：迁移按以下顺序执行：

1. 记录当前 A2A trace fixture，并给现有行为加兼容测试。
2. 引入 runtimeInstanceId、application event/state/effect journal。
3. 把 A2A adapter 从 Channel bridge 移入 a2a-binding，修复 authorization 恢复。
4. 发布声明式 extension manifest、conformance fixture 格式和通用 client SDK。
5. 用独立 reference application 验证 `manager-workers`，再从真实 repo 工作形成社区维护的
   `repo-maintenance` extension。
6. 最后再物理拆包，并发布“规范与客户端实现分离”的社区维护文档。

Benchmark 分三套，不混成一个总分：

- **Transport**：丢包、重复、乱序、离线、重连、延迟、吞吐和 retention。
- **Protocol conformance**：状态转移、重放、终态、审批、冲突与 loop freedom。
- **End-to-end**：`application extension/client × harness × model/configuration` 的任务成功率、
  成本、耗时、人工中断和安全违规。

**Transport 投资决定**：Local + HTTP relay 继续作为当前生产基线。NATS/SLIM 只保留
binding contract；在 Milestone 1/2 的可靠性或扩展指标证明 HTTP relay 是瓶颈前，不实现
NATS adapter。本段取代 D11 中“NATS 是下一阶段稳定 transport 目标”的时间优先级，但不
撤销 TransportBinding 扩展点。

**架构完成门**：

- runtime 重启后不会否认同 profile 的历史出站行为；
- AUTH_REQUIRED 在同一 task 上暂停和恢复；
- terminal event 不唤醒模型产生回复；
- 未支持的 extension 不自动执行；
- 普通正文不能伪造 owner approval；
- transport 替换不改变 application 规范或客户端行为；
- 同一 trace 可分别用于 transport、protocol 和 end-to-end benchmark。
