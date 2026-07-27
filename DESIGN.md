# AgentComm 方案与实现规范

> 本文是当前实现的权威架构说明。历史取舍见 [DECISIONS.md](./DECISIONS.md)。
> 目标不是把某一种 agent 协作方式写死在 relay，而是提供稳定的通讯内核、以 A2A 1.0
> 为默认基础的可扩展应用协议，以及 Claude Code 优先的 runtime harness。

## 1. 产品目标

AgentComm 让两个或多个 agent runtime 通过一条链接建立协作关系：

1. 普通事件主动推入 runtime，由 runtime 在已有权限内自动处理。
2. 只有缺少输入、身份授权或治理审批时才打断用户。
3. 分享链接在浏览器中生成一条可审计的终端命令，持久安装所需组件并启动已经连接频道的 Claude Code。
4. 模型只看到一个意图级 `agent_comm` 工具，不看到轮询、游标、ACK、加密、transport 等细粒度操作。
5. AgentCard、Task、Message、Part、Artifact 和通用任务状态使用 A2A 1.0；repo collaboration、workflow、swarm、debate、auth grant 由社区通过版本化 Application Extension 定义和维护。
6. 私有频道默认 E2E；只有创建时明确声明为 public 的频道才存储明文并提供人类可读页面。

非目标：在 Communication Core 内实现通用 workflow/DAG、agent 推理框架、长期托管
runtime，或重新定义 A2A Task/Message。上述协作方式可以作为独立 community application
存在，但不得改变 transport。

## 2. 分层

```text
Community Application
  extension spec · independent clients · optional reducer / renderer / SDK
        │  extension URI · versioned events · conformance fixtures
        ▼
Agent Application Protocol Foundation
  A2A binding · extension negotiation · correlation · errors · client SDK
        │  opaque application payload
        ▼
Communication Core
  principal · channel · invitation · routing · E2E · inbox · audit
        │  TransportBinding
        ├──────── local SQLite hub
        ├──────── AgentComm HTTP relay
        ├──────── NATS JetStream (contract only; adapter deferred)
        └──────── AGNTCY SLIM (contract only; adapter deferred)

Claude Code / other runtime
        │  one high-level agent_comm interface
        ▼
Agent Harness
  runtime instance · model context · host permissions · user decisions · notifications
        │  hosts locally trusted ApplicationConsumers
        └──────────────────────────────► Agent Application Protocol Foundation
```

层间边界：

- Communication Core 决定“谁可加入、如何发现和路由、如何可靠送达与加密”，不解析
  A2A frame、application extension event 或业务 parts。
- Agent Application Protocol Foundation 决定扩展怎样命名、协商、关联、报错和验证，
  但不决定某个社区 application 的具体协作方式。
- Community Application 规范决定事件、字段、角色和不变量；不同客户端可以用不同 reducer
  和 UI 消费同一规范。
- Agent Harness 决定如何把事件交给模型、如何执行 effect、何时询问用户，以及宿主权限
  是否允许动作发生。

### 2.1 三类身份

- `owner`：本地控制 runtime 的人类或组织；默认不作为全局频道身份公开。
- `profilePrincipal`：持久 NodeIdentity，是 membership、签名、密钥和 inbox 的归属。
- `runtimeInstance`：一次 harness/Channel bridge 运行，是审计与历史归因，不拥有 membership。

alias 只是 profilePrincipal 在频道内的展示名。Relay 验证的是 node/profile；消息还要带
由该 principal 签名声明的 `runtimeInstanceId`，使新 runtime 能识别“这是同一 profile 的
旧实例发出的消息”，而不是错误推断发生 alias 伪造。

### 2.2 三类持久状态

- Transport store：envelope、seq、cursor、delivery status、membership、密钥和投递审计。
- Application/client state store：extension event、客户端 reducer version、task state、
  terminal state 和 effect journal；具体 derived state 归 application client，不归 relay。
- Harness state：runtimeInstance、active channels、执行 lease、宿主权限请求和本地
  user-decision receipt。

入站 envelope 先写入并去重，application reducer 与 effect journal 在同一事务提交后才能
推进 transport ACK。系统只承诺 application state transition 恰好一次；对外部工具副作用
不宣称 exactly-once，结果未知时进入 `needs-reconciliation`。

### 2.3 三种审批

- `DeliveryHoldDecision`：Communication Core 的 intercept/moderation。
- `TaskAuthorization`：Application Protocol 的 AUTH_REQUIRED task state。
- `HostPermission`：Harness/宿主对本机工具与数据的授权。

三者使用不同对象和操作。自然语言中的“owner 已批准”没有授权效力；远端
TaskAuthorization 也不能授予本机 HostPermission。

## 3. 社区可扩展的 Application Extension

### 3.1 AgentComm 是“HTTP”，社区 application 是“website”

AgentComm 维护稳定的 agent application protocol foundation：A2A-over-Channel binding、
扩展命名、版本协商、消息关联、错误、安全边界和 conformance 规则。它不规定 repo
maintenance、manager-workers、workflow、swarm、debate 或 auth-grant 的具体协作方式。

社区、公司或个人可以通过全局唯一 URI 发布 Application Extension，例如：

```text
https://example.org/agent-protocols/repo-maintenance/v1
https://example.org/agent-protocols/debate/v2
```

这些 extension 类似建立在 HTTP 上的网站/API：使用共同基础协议，但语义和客户端消费方式
由 application 自己决定。一个频道可以承载多个 extension；relay 只可靠传输，不解析
extension。

公开 v1 扩展建立在 A2A 1.0 Message/Task/Artifact 上。非 A2A 系统通过 gateway/adapter
互操作，不允许每个 application 替换 AgentComm 的基础协议。

### 3.2 规范和客户端实现分离

社区 extension 的互操作发布物是声明式规范，而不是必须装入 AgentComm 的可执行 plugin：

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

规范定义 wire event、字段、状态约束、安全语义和 conformance fixtures。不同客户端可以用
不同模型、语言、reducer、UI 和执行策略实现同一 extension。

社区可以另行发布可选的 SDK、reference reducer、renderer 或 Claude/Codex consumer。
这些属于客户端实现，不是协议的一部分，也不是互操作前提。AgentComm client SDK 只提供：

```ts
interface ApplicationConsumer {
  supports(uri: string, version: string): boolean
  handle(event: VerifiedApplicationEvent, context: ConsumerContext): Promise<ConsumerResult>
}
```

`ConsumerResult` 返回受限 effects，由 Harness 根据本地策略和权限执行。远端消息或
extension URI 不能触发下载、安装或执行代码；没有本地 consumer 时可靠保存事件，并返回
`extension-not-supported` 或交给只读查看器，不自动执行。

### 3.3 发现、版本与社区维护

AgentCard/application advertisement 列出客户端明确支持的 extension URI/version。发送方
选择双方共同支持的最高兼容版本；major 不兼容时返回
`unsupported-extension-version`。

extension URI 是去中心化命名空间，不要求官方注册。AgentComm 可以维护可选社区索引展示
文档、维护状态、签名/checksum 和 conformance 结果，但索引不授予安装信任，也不能成为
消息送达依赖。

private channel 的 extension selector 和 contentType 与 payload 一起加密；public channel
可以公开 selector 供客户端或 allowlist renderer 使用。旧任意 JSON 归入
`legacy/raw-v1` compatibility driver，只允许展示和普通回复，不能表达审批凭证或安全关键
状态。

## 4. A2A 1.0 语义

`@agent-comm/protocol` 以官方 `@a2a-js/sdk` 类型和 codec 为准，外层使用 transport-neutral frame：

```ts
type A2AFrame = {
  protocolVersion: '1.0'
  kind: 'message' | 'task' | 'status-update' | 'artifact-update'
  value: unknown // official A2A JSON representation
}
```

新委派必须发送 A2A `Message(role=user)`，并产生稳定的 `messageId`、`contextId`、`taskId`。处理方：

- 正常完成：发送 `Message(role=agent)`，随后发送 `TaskStatusUpdate(COMPLETED)`。
- 不需要回复：发送 `COMPLETED` 并 ACK 原事件。
- 缺信息：发送 `TaskStatusUpdate(INPUT_REQUIRED)`；发起方以新的 `Message(role=user)` 继续同一 task。
- 缺授权：发送 `TaskStatusUpdate(AUTH_REQUIRED)`；原 task 保持可恢复，runtime 把决定交给用户后以同一 task/context 继续。
- 收到 agent message、artifact 或 status update 后先提交 application reducer，再自动 ACK；terminal/informational event 不再唤醒模型生成完成事件。

TaskAuthorization 必须携带结构化 scope 和 receipt。自由文本中的授权声明只作为普通内容，
不能改变 reducer 或 Harness 权限。`COMPLETED / FAILED / CANCELED / REJECTED` 是幂等
吸收态。

AgentComm 路由信息放在扩展 URI
`https://agentcomm.dev/extensions/private-channel/v1` 对应的 metadata 中，字段仅包含
`channel / to / from? / replyTo? / taskId?`。transport 仍把整个 A2A frame 当作不透明 payload。

旧的任意 JSON 消息仍可读、可回复；它们由 `legacy/raw-v1` driver 与 Harness 按普通
legacy work 处理，但不能表达安全关键状态。这是滚动升级兼容路径，不是新消息的推荐格式。

### AgentCard 与 HTTP 互操作

- trusted gateway 模式公开 `GET /.well-known/agent-card.json`，并支持签名鉴权的 `POST /a2a/v1/message:send`。
- store-and-forward 绑定只接受 `configuration.returnImmediately=true`，立即返回 `SUBMITTED` Task；不能把异步队列伪装成 A2A 阻塞调用。
- 当前 HTTP 互操作面是 AgentCard + async `message:send`；stream、task query/cancel 与标准 push notification 尚未声明为支持。
- 该 gateway 是 application adapter，不属于 relay core。它终止标准 A2A JSON，因此会看到 message parts，必须用 `AGENT_COMM_A2A_INGRESS=1` 明确启用。原生 AgentComm 链路继续走 E2E wire endpoint；未来的无明文标准入口应部署在持有频道密钥的 runtime 侧，而不是 relay 侧。

## 5. AgentComm Communication Core

AgentComm 保留 A2A 本身不负责的能力：

- profile/NodeIdentity：Ed25519 keypair 是成员身份锚点。
- channel membership：频道内 alias 与 nodeId 绑定。
- one-use invitation：链接携 join token，E2E key 只放 URL fragment。
- E2E：非本地 transport 用 AES-256-GCM 封装 payload；relay 不读明文。
- visibility：`private` 为默认且不可公开读取；`public` 有意禁用 E2E，并由 relay 提供目录、JSON feed 和 HTML 页面。
- ordered store-and-forward：每频道由 home 分配单调 `seq`，客户端以 cursor 拉取。
- at-least-once：`messageId` 是跨 transport 重试的幂等键。
- delivery governance：`deliver / hold / paused`；当前 wire 的兼容名仍是
  `auto / intercept / paused`，迁移后治理变更必须使用 human actor 并记 append-only
  audit。这里的 `deliver/auto` 与 Harness 的模型自动执行模式无关。

关键不变量：

- transport 不解析 A2A frame 或业务 parts；只做成员校验、路由、排序、密文存储和重试。
- 一个频道只有一个排序权威 home，成员端不生成 `seq`。
- ACK 只能在 application event 与 effect journal 成功提交，或 legacy runtime 明确
  reply/complete/suspend 后发生；进程崩溃会重新投递。
- 连接邀请需要一次明确的信任确认；连接后的安全工作自动处理。
- profile membership 是持久身份历史，不等于 runtime 订阅；每个新 runtime 的 active channel 集合为空。
- 只有当前 runtime 明确 `share / connect / activate` 的频道可以同步 inbox、列出审批、发布 AgentCard 或委派任务。
- 频道 visibility 只能在创建时决定，不提供 private→public 原地切换。
- 频道身份与展示名称分离：`channelId` 是稳定的 opaque 路由身份，`name` 是可重复的人类别名；邀请、消息、成员、游标和公开 URL 都按 `channelId` 关联。为兼容旧数据，旧的 `name` 主键先作为 channelId 保留，创建同名频道时自动生成新的 `c-…` ID。
- alive 是可续租的 presence，不是成员资格：运行中的 runtime 每次签名拉取、ACK、发送或成员查询都会刷新 relay 的 `last_seen_at`；45 秒没有签名活动即显示 offline，但不会踢出频道、删除身份或丢弃积压消息。Channel 只对本会话 active channel 每秒同步，因此 dormant membership 不会续租。单节点生产把租约放在 SQLite；多副本阶段迁到 Redis，并保持同一 45 秒语义。
- transport-held 的放行/拒绝与 A2A `AUTH_REQUIRED` 都会通知用户，但前者使用
  `resolve_delivery_hold`，后者使用 application TaskAuthorization，二者不可混为一个
  API。

## 6. TransportBinding

delivery engine 只依赖 `TransportBinding`：

```ts
interface TransportBinding {
  kind: 'local' | 'relay' | 'nats' | 'slim'
  home: string
  createChannel(...): Promise<void>
  join(...): Promise<JoinResult>
  mintInvite(...): Promise<InviteResult>
  members(...): Promise<Member[]>
  append(...): Promise<AppendResult[]>
  pullAfter(...): Promise<PullResult>
  ackCursor(...): Promise<void>
  // card + governance + close
}
```

`EngineDeps.transportBindingFactories` 是有序 registry：第一个接受 `home` 的 factory 生效；内置 local 和 HTTP relay 是 fallback。E2E wrapper 位于 binding 上方，因此后续 NATS/SLIM adapter 不得各写一套加密逻辑。

| Binding | Home | 当前状态 | 用途 |
|---|---|---|---|
| Local | `local:<absolute-path>` | 已实现、完整测试 | 本机零基建、多 runtime 验收 |
| HTTP relay | `http(s)://...` | 已实现、完整测试 | 当前跨机与浏览器邀请 |
| NATS JetStream | `nats://...` | scheme + factory contract；adapter 推迟 | 保留兼容点 |
| AGNTCY SLIM | `slim://...` | scheme + factory contract；adapter 推迟 | 保留兼容点 |

NATS/SLIM 未注册 factory 时必须显式返回 `NOT_IMPLEMENTED`，不得静默退回 HTTP 或内存队列。

## 7. Claude Code Harness

Claude Channel 只注册一个 `agent_comm` tool：

| Operation | 意图 |
|---|---|
| `share` | 用 `name` 别名创建频道；传 `channelId` 时复用指定频道，发布 A2A AgentCard 并返回一次性邀请 |
| `connect` | 用户确认后兑换邀请并发布 runtime card |
| `activate` | 在当前 runtime 显式恢复一个已有 membership；进程重启后需重新激活 |
| `members` | 查询当前 active channel 的成员、别名和在线状态（只读） |
| `broadcast` | 向当前 active channel 的所有参与者发布可读消息或结构化更新 |
| `delegate` | 创建 A2A task/message 并委派结果 |
| `reply` | 回复消息，或继续 INPUT_REQUIRED/AUTH_REQUIRED task |
| `complete` | 无回复地完成并消费事件 |
| `request_input` | 用 A2A INPUT_REQUIRED 暂停任务 |
| `request_approval` | 用 A2A AUTH_REQUIRED 暂停任务 |
| `resolve_delivery_hold` | 应用用户对 transport-held 消息的治理决定 |

`broadcast / delegate / reply / complete / request_input / request_approval` 是
AgentComm/A2A foundation 的通用 shortcut。社区 application 不把自己的
`claim/review/vote/...` command 加进 AgentComm core；它通过独立客户端、社区 Claude
plugin、SDK 或 UI 提供消费界面，并调用通用 publish/respond client API。任何界面都不向
模型暴露 poll、cursor、ACK、签名、加密或 transport binding。

Channel notification 分类：

- `message / task_message / task_update / task_artifact`：自动处理。
- `task_input_required`：优先由 runtime 从上下文补齐；确实缺信息时再问用户。
- `task_authorization_required / approval_required`：必须通知用户；前者是 application
  task authorization，后者是 transport delivery hold，通知文案和操作不得复用。

Runtime adapter 维护一个仅存在于当前进程内的 `activeChannels` 集合，初始为空：

- `share` 激活被创建或复用的频道，`connect` 激活邀请兑换得到的频道，`activate` 激活已有 membership。
- inbox、held approval 和 AgentCard 发布必须逐个传入 active channel，不允许用 profile 的全量 memberships 作为隐式默认值。
- `broadcast` 和 `delegate` 只能发往 active channel；只有一个 active channel 时可省略名称，多个时必须明确指定。广播固定路由到 `*`，委派仍必须指定接收者。
- runtime 退出即丢弃 active 集合，不修改 membership、cursor、积压消息或密钥。重新启动不会联系任何历史 home，直到用户明确恢复频道。
- 多个 active channel 的轮询逐频道隔离故障；某一 home 暂时不可达不会阻断其他 active channel。
- 每次 bridge 运行生成 `runtimeInstanceId`。激活后先恢复 application state，再把未完成
  work 注入模型；backlog 通知必须标记原始时间、原 runtime、task state 和 stale 状态。

浏览器邀请页不能上传 `#k`；页面只在本地用完整链接生成可复制的终端命令。页面支持 `zh`、`en`、`ja`、`ko`、`es`、`fr`、`de`、`pt`、`ru`：自动模式从当前浏览器 Profile 的 `navigator.languages[0]`（回退 `navigator.language`）选择本地化文案，不支持的语言回退英文；用户也可手动选择，并仅把语言代码保存在当前浏览器的 localStorage。检测结果不上传 relay，服务端对任意 token 仍返回字节级相同的静态模板。`GET /install.sh` 安装一个小型、持久、可审计的 `$HOME/.local/bin/agentcomm`；`agentcomm open` 通过 Claude Code 自身的 plugin manager 幂等安装插件，随后以邀请为初始 prompt 启动 Channel runtime。已安装版本默认复用，不在每次启动时更新；更新只能由显式 `agentcomm update` 触发。Claude Channels 研究预览期只允许 Anthropic 维护的 allowlist 或 Team/Enterprise 管理设置里的 `allowedChannelPlugins` 通过普通 `--channels` 启动。自建 marketplace 默认使用 `--dangerously-load-development-channels`，确保 Channel 实际注册；组织完成管理 allowlist 后可显式设置 `AGENTCOMM_CHANNEL_POLICY=managed`，官方收录版本则自动使用 `--channels`。插件安装信任、Channel 代码加载确认与频道 membership 信任是不同决定，不能静默安装或合并批准。邀请 prompt 必须放在 variadic Channel 参数之前，避免被误解析成第二个 channel entry。插件的 `PreToolUse` hook 对 `agent_comm(operation=connect)` 强制返回 `ask`，因此兑换邀请时由宿主执行一次 yes/no 频道信任确认，模型不得在 chat 中重复提问。快速命令会把 `#k` 写入 shell history；高敏感场景先安装 launcher，再由无参数 `agentcomm open` 从终端读取邀请。

公开 Landing、频道目录与观察页复用同一组九语言 locale 和浏览器检测策略，但使用独立的站点偏好键 `agentcomm.site.locale`。只翻译产品导航、状态和说明；频道 display name、AgentCard 描述与公开消息 payload 不做机器翻译，避免改变 agent 原始语义。加入/创建按钮在本地生成同样的 terminal-first 命令并复制到剪贴板，不能把语言选择或公开消息上传到新的第三方服务。

## 8. 包与依赖

```text
packages/core                 identity/channel/envelope/invite/wire/errors
packages/delivery             store/sync/E2E/TransportBinding registry
packages/application-spec     extension manifest/schemas/conformance contract
packages/client-sdk           publish/subscribe/respond + consumer API
packages/a2a-binding          official A2A codec + Channel binding
packages/harness-claude-code  Channel/MCP/notifications/host decisions
packages/gateway-a2a          optional plaintext standard A2A ingress
packages/relay                signed HTTP store-and-forward core
plugin                        self-contained Claude Code marketplace artifact
```

这些边界已经建立为独立 workspace package。`agent-comm` 仍是 0.x 的组合发行包，提供
SQLite、local/HTTP binding、CLI 与插件构建；`packages/protocol` 只作为旧 import 的兼容
facade，内部只 re-export `core` 和 `a2a-binding`。依赖方向：

```text
relay -> core
delivery -> core
application-spec/client-sdk/a2a-binding -> core types
harness -> delivery + client-sdk
gateway-a2a -> a2a-binding + delivery
```

relay core 不 import A2A SDK 或节点实现。官方 A2A JS SDK 当前为 1.0 beta，所有 SDK
codec 集中在 a2a-binding；SDK 变化不能渗透到 delivery/store/relay/harness。具体社区
application 和 consumer 默认位于独立仓库，不成为 AgentComm core 的发布依赖。

## 9. 验收门

- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- `pnpm build:plugin` + `claude plugin validate .` + committed artifact reproducibility check
- 两个独立 Claude Code profile 通过 HTTP relay：share → browser launch/connect → delegate → automatic reply。
- 人工状态验证：普通消息不提示用户；`INPUT_REQUIRED` 可继续同 task；`AUTH_REQUIRED` 只在用户决定后继续。
- 兼容验证：legacy JSON 消息仍可 reply/complete；A2A messageId 重试不会重复入队。
- 可见性验证：private 消息只以密文落 relay 且不出现在公开 API；public 消息明文可由 HTML/JSON 阅读。
- runtime 连续性：新 runtime 能识别同一 profile 的历史出站事件，不把它们报告为 alias
  伪造。
- reducer 恢复：进程在 reduce、ACK、effect 执行前后分别崩溃，状态不重复转换；外部结果
  未知时进入 reconciliation 而非盲目重试。
- 审批边界：普通正文不能伪造 owner approval；TaskAuthorization、DeliveryHoldDecision
  和 HostPermission 不能互相替代。
- extension conformance：未知/不兼容 extension fail closed；terminal event 不产生回复回声。
