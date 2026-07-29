# Runtime Ingress Adapters

AgentComm 的逻辑 `channel` 是通讯层的协作空间；Claude Code 的 `--channels` 是某个
Agent Harness 提供的入站事件接口。两者不再共用一个抽象。

统一的数据流是：

```text
AgentComm relay / local home
        ↓ durable inbox
AgentComm runtime event pump
        ↓ RuntimeIngressEvent
RuntimeIngressAdapter
        ↓
Claude Channel / Codex App Server / exec / polling / webhook / process
```

Application Protocol、A2A 和 Relay 都不需要知道事件最后通过哪种 Harness 接口消费。

## 通用契约

`@agent-comm/runtime-ingress` 定义：

- `RuntimeIngressEvent`：已经规范化、可供 Harness 消费的事件；
- `RuntimeIngressAdapter`：`start / deliver / stop` 生命周期；
- `RuntimeIngressCapabilities`：push/poll、wakeup、后台运行、审批和 durability 能力；
- `RuntimeIngressDispatcher`：有序选择和显式 failover；
- `createCallbackIngressAdapter`：兼容已有 callback 与测试。

`deliver()` 的结果分为：

| 状态 | 含义 |
|---|---|
| `accepted` | Harness 入口已经接收，不等于模型已经完成处理 |
| `deferred` | 暂时不可用；上游 inbox 保留事件并重试 |
| `unsupported` | 该 adapter 不能处理，可尝试下一个 |
| `rejected` | 确定性拒绝，不应该盲目重试 |

Dispatcher 默认不会在 `deferred` 后自动 failover。超时可能发生在接收方已经接受事件之后，
自动切换会导致重复启动 Harness。只有所有接收方按 `eventId` 去重时，才应启用
`fallbackOnDeferred`。

## 已实现 adapters

### Claude Code Native Channel

包：`@agent-comm/harness-claude-code`

把通用事件映射为 `notifications/claude/channel`。这是 Claude Code 的原生实时路径，也是目前
需要 `claude --channels` 或 development Channel flag 的唯一部分。

同一个包也提供 `ClaudeCodePrintIngressAdapter`。常驻 daemon 在没有 live Channel session
时可使用 `claude -p --output-format json`，完整事件从 stdin 输入，终态结果按 `eventId`
回到 Application Runtime。

### Codex

包：`@agent-comm/harness-codex`

- `CodexAppServerIngressAdapter` 持有独立 `codex app-server --listen stdio://`，每个
  AgentComm channelId 复用一个 thread，`turn/completed` 映射回原 eventId。Server
  approval request 默认 fail closed，只有本机宿主提供 callback 才能决定。
- `CodexExecIngressAdapter` 以 `codex exec --json --sandbox workspace-write -` 启动一次
  run。正文只进入 stdin；最后一个 `agent_message` 成为 correlated outcome。

两者都不会向任意已打开的 Codex Desktop 对话注入消息。App Server 是 AgentComm 自己持有的
runtime；Desktop 接入仍需一等 Host API。

### Polling

包：`@agent-comm/ingress-polling`

供不支持外部 push 的 Harness 主动读取。`poll()` 获得带 visibility lease 的事件；处理成功后
调用 `ack(eventId)`，失败调用 `nack(eventId, retryAfterMs)`。lease 到期会重新投递，同一
`eventId` 重复进入队列不会生成第二份事件。

```ts
const ingress = new PollingIngressAdapter({ defaultLeaseMs: 30_000 })
const [delivery] = ingress.poll({ limit: 1 })
if (delivery) {
  try {
    const result = await harness.run(delivery.event)
    await runtime.bridge.reply(delivery.event.eventId, result)
    ingress.ack(delivery.event.eventId)
  } catch {
    ingress.nack(delivery.event.eventId, 5_000)
  }
}
```

队列本身是进程内的；跨进程恢复依赖 AgentComm durable inbox。以后需要跨机器 pull service
时，可以实现相同接口并把 lease 存入 Redis、Postgres 或其他队列。

### Webhook

包：`@agent-comm/ingress-webhook`

向 Harness 的 HTTP endpoint `POST` 完整事件。可配置 HMAC：

```text
x-agentcomm-timestamp: <unix milliseconds>
x-agentcomm-signature: v1=<base64url HMAC-SHA256>

signed = timestamp + "." + rawBody
```

`2xx` 为 accepted，`409` 为幂等重复，`408/425/429/5xx` 为 deferred，
`404/405/415` 为 unsupported，其他 `4xx` 为 rejected。

### Process Spawn

包：`@agent-comm/ingress-process`

为每个事件启动一个一次性 Harness run，并通过 stdin 写入 JSON。实现始终使用
`spawn(..., { shell: false })`；远端事件内容不会拼接到 command 或 arguments。

- exit `0`：accepted；
- exit `75`：临时失败，deferred；
- exit `64/69`：unsupported；
- 其他非零：rejected。

超时、并发数、环境变量继承和 exit code 均可配置。默认不继承父进程环境，避免把凭据无意
交给新进程。

## 非 Claude Runtime 的组合入口

`agent-comm/runtime-ingress` 导出 `createIngressRuntime`。它不连接 MCP transport，也不依赖
Claude Code；调用方显式传入 adapter 和要激活的 `channelId`：

```ts
import { WebhookIngressAdapter } from '@agent-comm/ingress-webhook'
import { createIngressRuntime, resolveProfile } from 'agent-comm/runtime-ingress'

const runtime = await createIngressRuntime(resolveProfile({ profile: 'worker-1' }), {
  channels: ['c-example'],
  ingress: new WebhookIngressAdapter({
    url: 'http://127.0.0.1:9000/agentcomm/events',
    secret: process.env.AGENTCOMM_WEBHOOK_SECRET,
  }),
})

process.once('SIGTERM', () => void runtime.close())
```

所有 adapter 复用同一条持久 inbox、应用 reducer、effect journal、ACK 和恢复路径。
普通 A2A 工作通过 `runtime.bridge.reply / respond / complete` 完成。Application event
优先调用 `runtime.handleOutcome`：SDK 会把 Harness 结果交给社区 consumer 的 `resume`，
由协议生成 `response.created`、`task.completed` 等原生事件；通讯层不猜 workflow。

## ACK 与安全边界

Runtime Ingress 的 `accepted` 只代表 Harness 接口接收成功。业务任务是否完成仍由
Application Protocol 的 reply/complete/terminal event 表示。

- 远端正文始终是不可信数据；
- adapter 不能创建 Host Permission；
- webhook/process 的接收方必须按 `eventId` 去重；
- process command 和固定 arguments 只能由本机管理员配置；
- AgentComm durable inbox 是 adapter 崩溃后的恢复来源；
- `request-authorization` 不会投递给不支持交互审批的无人值守 adapter；context 保持
  unfinished，并可通过 `agentcomm app pending` 查看，不能自动批准。
