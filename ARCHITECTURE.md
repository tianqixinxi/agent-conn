# AgentComm 最终架构与组件

> 本文描述当前仓库已经实现并由测试覆盖的 foundation 架构。Runtime registry/daemon、
> Claude/Codex/process adapters、社区协议生命周期与分层 benchmark runner 已实现；真实
> worktree/PR workload 数据集和跨工程师连续使用验证仍按 [ROADMAP.md](./ROADMAP.md)
> 推进，不能和“基础架构已完成”混为一谈。

## 架构图

```mermaid
flowchart TB
    community["Community Application<br/>manager-workers / workflow / debate / auth-grant"]
    appSpec["@agent-comm/application-spec<br/>manifest / event selector / version negotiation"]
    clientSdk["@agent-comm/client-sdk<br/>consumer registry / reducer runtime / effect journal / conformance"]
    catalog["@agent-comm/application-catalog<br/>registry / install / trust / channel binding / update"]
    supervisor["@agent-comm/runtime-supervisor<br/>durable registry / heartbeat / native-first routing"]
    benchmark["@agent-comm/benchmark<br/>layered suites / thresholds / reports / comparison"]
    ingress["@agent-comm/runtime-ingress<br/>normalized event / capabilities / dispatcher"]
    harness["@agent-comm/harness-claude-code<br/>Claude native Channel adapter"]
    codex["@agent-comm/harness-codex<br/>Codex App Server / Codex Exec"]
    polling["@agent-comm/ingress-polling<br/>lease / ack / nack / redelivery"]
    webhook["@agent-comm/ingress-webhook<br/>HTTP push / HMAC / retry mapping"]
    process["@agent-comm/ingress-process<br/>safe spawn / JSON stdin / backpressure"]
    a2a["@agent-comm/a2a-binding<br/>A2A Message / Task / Artifact / AgentCard"]
    gateway["@agent-comm/gateway-a2a<br/>optional trusted plaintext A2A ingress"]
    delivery["@agent-comm/delivery<br/>TransportBinding / discovery / store-and-forward contract"]
    core["@agent-comm/core<br/>identity / channel / invite / envelope / E2E wire / audit"]
    runtime["agent-comm distribution<br/>SQLite implementations / CLI / composition root"]
    relay["@agent-comm/relay<br/>signed HTTP routing / public channels / join and landing pages"]
    localDb[("Local SQLite<br/>membership / inbox / app state / effects / approvals")]
    relayDb[("Relay SQLite<br/>routes / sequence / encrypted envelopes / public feed")]
    privateChannel["Private channel<br/>AES-256-GCM payload"]
    publicChannel["Public channel<br/>plaintext human-readable feed"]

    community --> appSpec
    community --> clientSdk
    catalog --> appSpec
    supervisor --> ingress
    benchmark -. evaluates .-> community
    benchmark -. evaluates .-> supervisor
    ingress --> harness
    ingress --> codex
    ingress --> polling
    ingress --> webhook
    ingress --> process
    harness --> clientSdk
    polling --> clientSdk
    webhook --> clientSdk
    process --> clientSdk
    harness --> a2a
    clientSdk --> appSpec
    a2a --> core
    gateway --> a2a
    gateway --> delivery
    runtime --> harness
    runtime --> codex
    runtime --> catalog
    runtime --> supervisor
    runtime --> delivery
    runtime --> core
    runtime --> localDb
    delivery --> relay
    relay --> relayDb
    core --> privateChannel
    core --> publicChannel
```

核心原则是：Application Extension 决定“agent 怎样协作”，Communication Core 只决定
“谁能加入、消息怎样发现、路由、加密和可靠送达”。社区 application 不依赖 relay、MCP、
Claude Code 或 transport；换一个 harness、model 或 transport 时，wire application 语义
不变。

## 组件清单

| 组件 | 当前职责 | 不能做什么 |
|---|---|---|
| `@agent-comm/core` | Node/profile 身份、runtimeInstanceId、频道/邀请、信封、wire、错误、三类审批对象 | 不解析 A2A 或业务事件 |
| `@agent-comm/delivery` | `TransportBinding`、binding registry、可靠投递契约 | 不决定 task/workflow |
| `@agent-comm/a2a-binding` | 官方 A2A 1.0 codec、AgentCard、Task/Message/Artifact、私有频道 routing metadata | 不持久化、不执行工具 |
| `@agent-comm/application-spec` | extension URI、SemVer、manifest、AgentCard advertisement、版本协商、fixture schema | 不下载或执行社区代码 |
| `@agent-comm/client-sdk` | `publish/respond`、本地 consumer registry、事务 reducer、effect journal、重启恢复、conformance runner、legacy driver | 不把远端消息直接变成本机权限 |
| `@agent-comm/application-catalog` | 社区协议搜索、安装、代码信任、按 channelId 启停、更新/回滚来源与 manifest 加载 | 不因频道消息自动安装或执行代码 |
| `@agent-comm/runtime-ingress` | 规范化入站事件、Harness capabilities、adapter 生命周期和有序 dispatcher | 不理解频道、Relay、A2A 或业务 workflow |
| `@agent-comm/runtime-supervisor` | 持久 runtime registry、显式频道恢复、adapter 自动探测、heartbeat、native/local/remote 优先路由 | 不扫描或接管未注册会话 |
| `@agent-comm/harness-claude-code` | Claude Native Channel 与无交互 `claude -p` outcome adapter | 不再承担通用轮询、路由或应用状态 |
| `@agent-comm/harness-codex` | Codex App Server JSONL thread/turn adapter 与 `codex exec --json` adapter，结果关联原 eventId | 不注入任意已有 Desktop 对话，不替用户批准 host action |
| `@agent-comm/ingress-polling` | visibility lease、pull、ACK/NACK 和进程内重投递 | 不主动唤醒不支持 push 的 Harness |
| `@agent-comm/ingress-webhook` | HTTP push、可选 HMAC、状态码重试分类 | 不信任远端正文，不创建 Host Permission |
| `@agent-comm/ingress-process` | `shell:false` 启动一次性 run、JSON stdin、超时和背压 | 不把事件内容拼入 command/arguments，不默认继承环境 |
| `@agent-comm/benchmark` | transport/application/harness/model/system suite、阈值、p50/p95/吞吐/正确率报告与基线比较 | 不把 transport 失败混入模型质量分 |
| `@agent-comm/gateway-a2a` | 可选的 trusted plaintext A2A HTTP ingress 与 async submitted response | 不是 E2E relay，默认不启用 |
| `agent-comm` | Node/SQLite 实现、E2E wrapper、HTTP/local binding、CLI、runtime daemon、launchd/systemd service 与 composition root | 不是某个业务 workflow |
| `@agent-comm/relay` | 签名 HTTP store-and-forward、排序、membership、邀请、公开频道 feed、安装/加入页面、CLI bundle 和社区协议 registry | 私有频道不读 application payload |
| `applications/manager-workers` | 独立 reference application：注册、分配、进度、暂停、授权、完成、review | 不进入 core 发布依赖 |
| `applications/request-response` | 最小 request/response/failure/cancel 协议，用于跨 Harness E2E 和社区模板 | 不规定模型或 transport |
| `plugin` | 可安装的 Claude Code marketplace artifact | 不替代 Claude 的插件/频道信任确认 |
| `packages/protocol` | 0.x 兼容 facade，只 re-export core 与 A2A binding | 新代码不应继续向这里堆职责 |

## 一条 application event 的处理路径

```mermaid
sequenceDiagram
    participant Sender as Sender Application
    participant Ingress as Runtime Ingress
    participant Harness as Agent Harness
    participant Delivery as Delivery Binding
    participant Relay as Relay
    participant Runtime as Receiver Runtime
    participant Store as Application Store
    participant Consumer as Community Consumer

    Sender->>Harness: publish(uri, version, eventType, body)
    Harness->>Harness: verify peer AgentCard support
    Harness->>Delivery: signed opaque A2A envelope
    Delivery->>Relay: append(messageId)
    Relay-->>Delivery: seq and delivery status
    Delivery->>Runtime: at-least-once event
    Runtime->>Store: persist and dedupe by messageId
    Runtime->>Consumer: pure reducer(event, state)
    Consumer-->>Runtime: next state and data-only effects
    Runtime->>Store: transaction(state, event, effect journal)
    Runtime-->>Delivery: ACK after commit
    Runtime->>Runtime: execute allowed effects under host policy
    opt effect requests agent work
      Runtime->>Ingress: normalized RuntimeIngressEvent
      Ingress->>Harness: native / app-server / exec / process
      Harness-->>Runtime: correlated outcome(eventId)
      Runtime->>Consumer: resume(source event, outcome, state)
      Consumer-->>Runtime: protocol-native effects
      Runtime->>Delivery: response.created / task.completed / ...
    end
```

状态变更是 exactly-once；网络投递是 at-least-once；外部工具副作用不伪装成
exactly-once。执行中崩溃的 effect 会进入 `needs-reconciliation`，由宿主或 application
明确核对。

## 审批与信任边界

三类决策互不替代：

1. `DeliveryHoldDecision`：transport 的 intercept/moderation。
2. `TaskAuthorization`：同一 A2A task/context 上的结构化 `AUTH_REQUIRED` 与 receipt。
3. `HostPermission`：Claude Code 或其他 harness 对本机工具、文件和凭据的授权。

插件安装信任、Channel 代码加载信任、频道 membership 信任也分别确认。远端文字“owner
已经批准”只是数据，不能生成 receipt，更不能授予本机 HostPermission。

## 扩展和兼容

- runtime 在 AgentCard 中广告本地已安装 consumer 的 URI、最高版本和兼容下界。
- 定向 `publish` 在发送前协商；未知 URI 返回 `EXTENSION_NOT_SUPPORTED`，版本不兼容返回
  `EXTENSION_VERSION_UNSUPPORTED`，不会把不可执行事件发送给对端。
- 未安装 consumer 的入站事件会可靠记录、ACK 并以只读数据展示，不动态安装代码。
- `legacy/raw-v1` 只允许显示和普通回复，不能携带 task authorization、receipt 或工具权限。
- community package 可仅依赖 `application-spec` 与 `client-sdk`，通过 conformance fixture
  在没有 relay、MCP、Claude 或模型的环境中验证 reducer。
- manifest 是数据；只有本地 `app install --allow-code` 的显式决定才允许加载 executable
  consumer。安装和频道启用是两个不同操作。

## 已有自动化验收

- application state + event + effect journal 的事务提交和重启恢复；
- 重复消息不重复 reduce，terminal state 吸收晚到事件；
- AgentCard 扩展广告、兼容版本协商和 fail-closed 发送；
- task authorization 保持同一 task/context，receipt 决策不可变；
- agent result/terminal update 自动 ACK，避免完成消息 ping-pong；
- manager-workers 完整 manager → worker → review 流程；
- Runtime Ingress dispatcher、poll lease/redelivery、webhook HMAC/重试分类、process 安全启动；
- Claude Native Channel 与非 MCP `createIngressRuntime` 复用同一事件泵；
- Codex Exec / App Server、Claude Print 和通用 Process outcome 自动回到原 eventId；
- application `resume` 把 Harness 结果翻译成协议自己的 `response.created` /
  `task.completed`，通讯层不硬编码 workflow；
- runtime registry、受控 auto-resume、heartbeat、launchd/systemd service；
- application create/validate/test/search/install/inspect/enable/update/disable/remove；
- Claude Native → Codex Exec 的普通 A2A 和 request-response protocol 双 E2E；
- 五层 benchmark suite/runner、阈值报告和 baseline comparison；
- core/relay 不直接依赖 A2A SDK、community app 不依赖 communication internals；
- 冷启动 launcher 生成独立 `runtimeInstanceId` 并保持插件安装与频道信任分离。
