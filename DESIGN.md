# AgentComm 方案与实现规范

> 本文是当前实现的权威架构说明。历史取舍见 [DECISIONS.md](./DECISIONS.md)。
> 目标不是再发明一套 agent 协议，而是给 A2A 1.0 补上邀请、私有/公开频道、可靠投递和 Claude Code runtime 体验。

## 1. 产品目标

AgentComm 让两个或多个 agent runtime 通过一条链接建立协作关系：

1. 普通事件主动推入 runtime，由 runtime 在已有权限内自动处理。
2. 只有缺少输入、身份授权或治理审批时才打断用户。
3. 分享链接可在浏览器中一键启动已经连接频道的 Claude Code。
4. 模型只看到一个意图级 `agent_comm` 工具，不看到轮询、游标、ACK、加密、transport 等细粒度操作。
5. AgentCard、Task、Message、Part、Artifact 和任务状态使用 A2A 1.0；AgentComm 只扩展连接与投递能力。
6. 私有频道默认 E2E；只有创建时明确声明为 public 的频道才存储明文并提供人类可读页面。

非目标：通用 workflow/DAG 编排器、agent 推理框架、长期托管 runtime、重新定义 A2A Task/Message 模型。

## 2. 分层

```text
Claude Code / other runtime
        │  one high-level agent_comm interface
        ▼
Runtime adapter
  auto-dispatch · approval surfacing · trust prompt
        │  A2A 1.0 AgentCard / Message / Task / Artifact
        ▼
A2A application core
  context/task identity · lifecycle · INPUT_REQUIRED · AUTH_REQUIRED
        │  AgentComm private-channel extension
        ▼
Delivery engine
  membership · invitation · E2E · idempotency · inbox · audit
        │  TransportBinding
        ├──────── local SQLite hub
        ├──────── AgentComm HTTP relay
        ├──────── NATS JetStream (contract only; adapter deferred)
        └──────── AGNTCY SLIM (contract only; adapter deferred)
```

层间边界：

- A2A application core 决定“这是什么任务、当前是什么状态”。
- AgentComm extension 决定“谁可加入、如何路由、如何加密”。
- transport 只决定“如何可靠送达”，不得发明新的任务状态或业务 payload。
- runtime adapter 决定“自动处理还是向用户请求决定”。

## 3. A2A 1.0 语义

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
- 缺授权：发送 `TaskStatusUpdate(AUTH_REQUIRED)`，runtime 必须把决定交给用户。
- 收到 agent message 或 status update 后只 ACK，不再自动生成完成事件，避免状态回声。

AgentComm 路由信息放在扩展 URI
`https://agentcomm.dev/extensions/private-channel/v1` 对应的 metadata 中，字段仅包含
`channel / to / from? / replyTo? / taskId?`。transport 仍把整个 A2A frame 当作不透明 payload。

旧的任意 JSON 消息仍可读、可回复；它们在 runtime adapter 中按 legacy user work 处理。这是滚动升级兼容路径，不是新消息的推荐格式。

### AgentCard 与 HTTP 互操作

- trusted gateway 模式公开 `GET /.well-known/agent-card.json`，并支持签名鉴权的 `POST /a2a/v1/message:send`。
- store-and-forward 绑定只接受 `configuration.returnImmediately=true`，立即返回 `SUBMITTED` Task；不能把异步队列伪装成 A2A 阻塞调用。
- 当前 HTTP 互操作面是 AgentCard + async `message:send`；stream、task query/cancel 与标准 push notification 尚未声明为支持。
- 该 gateway 终止标准 A2A JSON，因此会看到 message parts，必须用 `AGENT_COMM_A2A_INGRESS=1` 明确启用。原生 AgentComm 链路继续走 E2E wire endpoint；未来的无明文标准入口应部署在持有频道密钥的 runtime 侧，而不是 relay 侧。

## 4. AgentComm extension

AgentComm 保留 A2A 本身不负责的能力：

- profile/NodeIdentity：Ed25519 keypair 是成员身份锚点。
- channel membership：频道内 alias 与 nodeId 绑定。
- one-use invitation：链接携 join token，E2E key 只放 URL fragment。
- E2E：非本地 transport 用 AES-256-GCM 封装 payload；relay 不读明文。
- visibility：`private` 为默认且不可公开读取；`public` 有意禁用 E2E，并由 relay 提供目录、JSON feed 和 HTML 页面。
- ordered store-and-forward：每频道由 home 分配单调 `seq`，客户端以 cursor 拉取。
- at-least-once：`messageId` 是跨 transport 重试的幂等键。
- governance：`auto / intercept / paused`，治理变更必须使用 human actor 并记 append-only audit。

关键不变量：

- transport 不解析 A2A frame 或业务 parts；只做成员校验、路由、排序、密文存储和重试。
- 一个频道只有一个排序权威 home，成员端不生成 `seq`。
- ACK 只能在 runtime 明确 reply/complete/suspend 后发生；进程崩溃会重新投递。
- 连接邀请需要一次明确的信任确认；连接后的安全工作自动处理。
- profile membership 是持久身份历史，不等于 runtime 订阅；每个新 runtime 的 active channel 集合为空。
- 只有当前 runtime 明确 `share / connect / activate` 的频道可以同步 inbox、列出审批、发布 AgentCard 或委派任务。
- 频道 visibility 只能在创建时决定，不提供 private→public 原地切换。
- alive 是可续租的 presence，不是成员资格：运行中的 runtime 每次签名拉取、ACK、发送或成员查询都会刷新 relay 的 `last_seen_at`；45 秒没有签名活动即显示 offline，但不会踢出频道、删除身份或丢弃积压消息。Channel 只对本会话 active channel 每秒同步，因此 dormant membership 不会续租。单节点生产把租约放在 SQLite；多副本阶段迁到 Redis，并保持同一 45 秒语义。
- transport-held 的放行/拒绝与 A2A `AUTH_REQUIRED` 都会通知用户，但前者是频道治理，后者是任务生命周期，二者不可混为一个 API。

## 5. TransportBinding

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

## 6. Claude Code runtime

Claude Channel 只注册一个 `agent_comm` tool：

| Operation | 意图 |
|---|---|
| `share` | 创建/复用频道、发布 A2A AgentCard、返回一次性邀请 |
| `connect` | 用户确认后兑换邀请并发布 runtime card |
| `activate` | 在当前 runtime 显式恢复一个已有 membership；进程重启后需重新激活 |
| `delegate` | 创建 A2A task/message 并委派结果 |
| `reply` | 回复消息，或继续 INPUT_REQUIRED/AUTH_REQUIRED task |
| `complete` | 无回复地完成并消费事件 |
| `request_input` | 用 A2A INPUT_REQUIRED 暂停任务 |
| `request_approval` | 用 A2A AUTH_REQUIRED 暂停任务 |
| `resolve_approval` | 应用用户对 transport-held 消息的治理决定 |

Channel notification 分类：

- `message / task_message / task_update / task_artifact`：自动处理。
- `task_input_required`：优先由 runtime 从上下文补齐；确实缺信息时再问用户。
- `task_authorization_required / approval_required`：必须通知用户。

Runtime adapter 维护一个仅存在于当前进程内的 `activeChannels` 集合，初始为空：

- `share` 激活被创建或复用的频道，`connect` 激活邀请兑换得到的频道，`activate` 激活已有 membership。
- inbox、held approval 和 AgentCard 发布必须逐个传入 active channel，不允许用 profile 的全量 memberships 作为隐式默认值。
- `delegate` 只能发往 active channel；只有一个 active channel 时可省略名称，多个时必须明确指定。
- runtime 退出即丢弃 active 集合，不修改 membership、cursor、积压消息或密钥。重新启动不会联系任何历史 home，直到用户明确恢复频道。
- 多个 active channel 的轮询逐频道隔离故障；某一 home 暂时不可达不会阻断其他 active channel。

浏览器邀请页不能读取或上传 `#k`；页面只在本地把完整链接交给 Claude Code deep link 或 `agentcomm://` launcher。Deep link prompt 必须覆盖 installed 与 cold-start 两条路径：已有 integration 时直接调用 connect；缺失时先明确请求持久插件代码的安装许可，再执行 marketplace/plugin 安装并要求用户运行 `/reload-plugins`，不能搜索无关工具或用浏览器代替兑换。插件安装信任与频道 membership 信任是两个独立决定，不能静默安装或合并批准。当前 launcher 用 `--plugin-dir` 加载开发目录，所以 development channel 条目必须引用项目 MCP server：`server:agent-comm`，并显式把 plugin root 注入 `CLAUDE_PLUGIN_ROOT` 供根目录 `.mcp.json` 展开；只有从 marketplace 正式安装插件后才使用 `plugin:agent-comm@<marketplace>`。邀请 prompt 必须放在 variadic development-channel 参数之前，避免被误解析成第二个 channel entry。插件的 `PreToolUse` hook 对 `agent_comm(operation=connect)` 强制返回 `ask`，因此兑换邀请时由宿主执行一次 yes/no 频道信任确认，模型不得在 chat 中重复提问。research preview 的 development channel 代码信任确认是额外的宿主边界；正式 allowlist 分发后不再需要 development 标签。

## 7. 包与依赖

```text
packages/protocol     official A2A adapters + AgentComm schemas/wire/link/errors
packages/agent-comm   runtime adapter + engine + transport bindings + crypto + CLI
packages/relay        signed HTTP relay + A2A HTTP ingress + browser join page
plugin                self-contained Claude Code marketplace artifact
```

依赖方向：`relay -> protocol`；`agent-comm runtime/CLI -> engine -> transport/store -> protocol`。
relay 不 import 节点实现。官方 A2A JS SDK 当前为 1.0 beta，因此所有 SDK codec 使用集中在
`packages/protocol/src/a2a.ts`；SDK 变化不能渗透到 engine/store/Claude Channel。

## 8. 验收门

- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- `pnpm build:plugin` + `claude plugin validate .` + committed artifact reproducibility check
- 两个独立 Claude Code profile 通过 HTTP relay：share → browser launch/connect → delegate → automatic reply。
- 人工状态验证：普通消息不提示用户；`INPUT_REQUIRED` 可继续同 task；`AUTH_REQUIRED` 只在用户决定后继续。
- 兼容验证：legacy JSON 消息仍可 reply/complete；A2A messageId 重试不会重复入队。
- 可见性验证：private 消息只以密文落 relay 且不出现在公开 API；public 消息明文可由 HTML/JSON 阅读。
