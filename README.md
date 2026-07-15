# agent-comm

基于 **A2A 1.0 + 私密频道**的 agent runtime 连接层：装进 Claude Code，凭一条邀请链接建立 E2E 连接；普通工作自动处理，只有输入、授权或治理审批需要人介入。

- 需求与硬约束:`../meee2-workspace/doc/prd/agent-comm-requirements-handoff.md`(R/S/C)
- 设计基准:`../meee2-workspace/doc/prd/agent-comm-mcp-spec.md`(§)
- **实现架构与模块契约:[DESIGN.md](./DESIGN.md)** · **拍板记录:[DECISIONS.md](./DECISIONS.md)**

## 布局

```
packages/protocol     A2A adapter + AgentComm 信封/wire/链接格式
packages/agent-comm   Claude runtime adapter + engine + transport + CLI
packages/relay        签名 HTTP relay + A2A HTTP ingress + 浏览器邀请页
```

## 开发

```bash
pnpm install
pnpm typecheck   # tsc 全仓
pnpm test        # vitest 全仓
pnpm lint        # biome
pnpm agent-comm -- --help          # 跑节点 CLI(tsx,仅限仓库目录内)
pnpm relay                          # 跑中继(默认 :8787)
pnpm build:cli                     # 打包免加载器的 CLI 到 packages/agent-comm/dist
bin/ac --help                      # 打包产物的入口(任意目录可用;需先 build:cli)
```

约定:Node ≥ 22(用 `node:sqlite`,零原生依赖);ESM + NodeNext(包内相对 import 带 `.js` 后缀);zod v3 API;严格模式,`pnpm typecheck`/`test`/`lint` 三绿为完成线(DESIGN §5)。

## Claude Code Channel

`channel` 入口把 AgentComm 变成事件驱动的 Claude Code Channel：A2A Message/Task 到达后会直接唤醒正在运行的 Claude，由 Claude 在已有权限内自动处理；只有 A2A `AUTH_REQUIRED`、Claude Code 自己的权限提示或频道 `intercept` 治理需要人介入。

Claude 只会看到一个意图级 MCP 工具 `agent_comm`，包含 `share / connect / delegate / reply / complete / request_input / request_approval / resolve_approval`。建频道、发布 AgentCard、铸邀请、轮询、游标、ACK、加密和 transport 都不会作为独立工具暴露。消息只有在 Claude 成功回复、完成或暂停任务后才消费；会话异常退出时会在下次启动重新投递。

本机开发启动：

```bash
pnpm build:cli

# 可选但推荐：提供浏览器的一键 agentcomm:// 入口（当前为 macOS）
bin/ac install-launcher                   # 默认 auto：每个 Claude session 使用独立身份
# 需要固定身份时可用：bin/ac install-launcher --runtime-profile bob

# 需要浏览器可打开的 HTTP 邀请时启动 relay
RELAY_DB="$PWD/.tmp/relay.db" pnpm relay
```

Claude Code Channels 仍处于 research preview。开发中的自定义频道需要显式启用：

```bash
CLAUDE_PLUGIN_ROOT="$PWD" \
AGENT_COMM_RELAY_URL=http://127.0.0.1:8787 \
claude --plugin-dir "$PWD" \
  --dangerously-load-development-channels server:agent-comm
```

在 Claude 里可以直接说：

```text
创建并分享频道 claude-duet，别名 alice，auto 模式，邀请只允许使用一次。
```

返回的完整 `http://…/j/…#k=…` 链接可以在浏览器打开。页面的主按钮通过 `agentcomm://` 启动一个已启用 AgentComm Channel 的 Claude Code；兑换邀请前会有一次宿主强制的连接审批。research preview 下 Claude 还会先确认加载本地 development channel，这是插件代码信任，与加入某个频道的连接审批是两个独立边界。官方 `claude-cli://` 入口和 `npx agent-comm join` 命令作为降级路径保留。`#k` 是 E2E 密钥，只在浏览器本地和两个 runtime 之间传递，不会发送给 relay。

### 两个 Claude Code 端到端验收

先按上面的方式启动 relay，然后开两个终端：

```bash
# 终端 A
CLAUDE_PLUGIN_ROOT="$PWD" \
AGENT_COMM_CHANNEL_PROFILE=alice AGENT_COMM_CHANNEL_ALIAS=alice \
AGENT_COMM_RELAY_URL=http://127.0.0.1:8787 \
claude --plugin-dir "$PWD" \
  --dangerously-load-development-channels server:agent-comm

# 终端 B
CLAUDE_PLUGIN_ROOT="$PWD" \
AGENT_COMM_CHANNEL_PROFILE=bob AGENT_COMM_CHANNEL_ALIAS=bob \
AGENT_COMM_RELAY_URL=http://127.0.0.1:8787 \
claude --plugin-dir "$PWD" \
  --dangerously-load-development-channels server:agent-comm
```

1. 在 Alice 中说“创建并分享频道 `claude-duet`，邀请只允许使用一次”。
2. 在 Bob 中粘贴完整邀请链接并说“连接这个邀请，别名 `bob`”。Claude Code 必须显示一次宿主级 permission；选择允许后才会兑换邀请。也可先用 `--runtime-profile bob` 安装 launcher，再在浏览器打开链接，用主按钮启动 Bob runtime。
3. 在 Alice 中说“让 `bob` 检查 README 的 Channel 验收步骤并回复结论”。
4. Bob 应自动收到 Channel 事件、执行任务并回复；Alice 自动收到回复。正常消息不要求人工轮询收件箱。如果消息只出现在 `bin/ac --profile bob inbox` 而 Bob 没有启动，检查启动横幅必须显示 `messages from server:agent-comm inject directly in this session`，且不能出现 `plugin not installed`。

任务状态验收：让 Bob 缺少必要信息时返回 `INPUT_REQUIRED`，Alice 补充后应继续同一个 task；让 Bob 执行需要授权的动作时返回 `AUTH_REQUIRED`，此时才应请求用户决定。

Channel 只在 Claude Code 会话运行期间接收事件；需要常驻处理时，应把 Claude 放在持久终端或后台进程中。远程 relay 的消息体已经 E2E 加密；远程 `intercept` 治理端点仍属于后续里程碑，本机频道的治理门已可用。

## 协议与 transport 状态

- 应用语义：A2A 1.0 `AgentCard / Message / Task / Artifact`。
- 已实现 transport：本机 SQLite home、签名 HTTP store-and-forward relay。
- 可选 trusted gateway：`AGENT_COMM_A2A_INGRESS=1 pnpm relay` 开启 AgentCard discovery 和异步 HTTP+JSON `message:send`。该模式会在 relay 终止标准 A2A JSON；原生 AgentComm 邀请链路仍保持 E2E。
- 下一稳定 transport：NATS JetStream；factory contract 已完成，adapter 尚未交付。
- 后续实验 transport：AGNTCY SLIM；等待 Node binding 成熟。

详见 [DESIGN.md](./DESIGN.md) 的分层、状态机和 binding matrix。
