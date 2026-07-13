import { isAgentCommError } from '@agent-comm/protocol'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ProfilePaths } from '../config.js'
import type { Actor, Engine, HeldMessage } from '../engine/api.js'
import { MCP_SERVER_INFO, toolDescriptions, toolInputs } from './tools.js'

/**
 * W2 实现处:`agent-comm serve`(stdio MCP server,spec §5/§7.1)。
 *
 * SDK 实际 API(@modelcontextprotocol/sdk@1.29.0,见 node_modules 内 README/类型):
 * - 子路径导入(包无顶层 index):`server/mcp.js`(McpServer)、`server/stdio.js`(StdioServerTransport)、
 *   `shared/transport.js`(Transport 类型)、`types.js`(CallToolResult 等)。
 * - `McpServer#registerTool(name, { description, inputSchema }, handler)`:`inputSchema` 可直接传
 *   `z.object({...})`(整份 ZodObject 落在 SDK 的 `AnySchema` 分支,handler 参数据此推导,无需拆成裸 shape)。
 * - elicitation:`server.server.elicitInput({ mode:'form', message, requestedSchema })` →
 *   `Promise<{action:'accept'|'decline'|'cancel', content?: Record<string, string|number|boolean|string[]>}>`;
 *   宿主是否支持通过 `server.server.getClientCapabilities()?.elicitation?.form` 运行时探测
 *   (@see tryReleaseHeld)。
 * - `server.server.onclose`(Protocol 上的公开字段,注意不是 transport.onclose——SDK 的
 *   `connect()` 会接管 transport 自身的 onclose/onmessage/onerror)是拿到"连接断开"事件、
 *   在此收尾 `engine.close()` 的正确挂载点。
 */

// —— actor 解析(审计用,§6.3/I6)——

/**
 * 解析本次工具调用要记的 actor 标签:
 * 1. 入参本身就带了"以此 alias 建立/加入某频道"的语义(create_channel/join_channel/connect)→ 直接用它。
 * 2. 否则若入参给了 channel(leave_channel/create_invite/send 指定频道时)→ 查 whoami().memberships 里
 *    该频道对应的 alias。
 * 3. 否则若我总共只加入了一个频道 → 用那个频道的 alias。
 * 4. 都拿不到 → 'agent:self'(任务指示的兜底值)。
 * 这只影响审计里 actor 字段怎么写,不影响 engine 的权限判定(engine 只要求非 'human' 即可,I4)。
 */
async function resolveActor(
  engine: Engine,
  ctx: { channel?: string | undefined; alias?: string | undefined },
): Promise<Actor> {
  if (ctx.alias) return `agent:${ctx.alias}`
  const who = await engine.whoami()
  if (ctx.channel) {
    const membership = who.memberships.find((m) => m.channel === ctx.channel)
    if (membership) return `agent:${membership.alias}`
  } else if (who.memberships.length === 1) {
    const only = who.memberships[0]
    if (only) return `agent:${only.alias}`
  }
  return 'agent:self'
}

// —— 工具返回包装(AgentCommError → isError,不抛裸异常)——

async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn()
    return { content: [{ type: 'text', text: JSON.stringify(data === undefined ? { ok: true } : data) }] }
  } catch (err) {
    if (isAgentCommError(err)) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: err.code, message: err.message }) }],
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ code: 'INTERNAL_ERROR', message }) }],
    }
  }
}

// —— F4 intercept 放行(§7.1)——

function summarizePayload(payload: unknown): string {
  let text: string
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  } catch {
    text = String(payload)
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * read_inbox 之后尝试放行 held 消息(F4):对每条 held 发 elicitation 问 accept/reject,
 * 按人的答复调 engine.deliverHeld/dropHeld(actor 'human')。
 * - 宿主不支持 elicitation(表单模式)→ 只在 stderr 提示一次,引导用 CLI。
 * - 不阻塞 read_inbox 的返回:调用方用 `void tryReleaseHeld(...).catch(() => {})`,本函数
 *   自身也吞掉逐条失败,失败即停止后续尝试并退回 CLI 提示,不让异常向上传播。
 * - payload 摘要只是给人看的原样字符串化(I1:不解析/不按 contentType 分支处理内容)。
 */
async function tryReleaseHeld(
  server: McpServer,
  engine: Engine,
  stderr: (chunk: string) => void,
): Promise<void> {
  let held: HeldMessage[]
  try {
    held = await engine.listHeld()
  } catch {
    return
  }
  if (held.length === 0) return

  const caps = server.server.getClientCapabilities()
  if (!caps?.elicitation?.form) {
    stderr(
      `agent-comm: ${held.length} 条消息待人工放行,当前宿主不支持 MCP elicitation。` +
        '请用 `agent-comm held` 查看,`agent-comm deliver <messageId>` / `agent-comm drop <messageId>` 处理。\n',
    )
    return
  }

  for (const { message, channel } of held) {
    try {
      const result = await server.server.elicitInput({
        mode: 'form',
        message:
          `频道「${channel}」收到一条待放行消息(intercept 模式):\n` +
          `from=${message.from} to=${message.to} contentType=${message.contentType ?? '(未标注)'}\n` +
          `payload 摘要:${summarizePayload(message.payload)}`,
        requestedSchema: {
          type: 'object',
          properties: {
            decision: {
              type: 'string',
              title: '放行决定',
              description: 'accept = 投递给收件人;reject = 丢弃',
              enum: ['accept', 'reject'],
              enumNames: ['放行(accept)', '丢弃(reject)'],
            },
          },
          required: ['decision'],
        },
      })
      const decision = result.action === 'accept' ? result.content?.decision : undefined
      if (decision === 'accept') {
        await engine.deliverHeld({ messageId: message.messageId }, 'human')
      } else if (decision === 'reject') {
        await engine.dropHeld({ messageId: message.messageId }, 'human')
      }
      // decline/cancel/未选择:消息留 held,下次 read_inbox 再问一次
    } catch (err) {
      stderr(
        `agent-comm: elicitation 放行消息 ${message.messageId} 失败:` +
          `${err instanceof Error ? err.message : String(err)}。请改用 \`agent-comm held\` CLI 处理。\n`,
      )
      return
    }
  }
}

// —— onInboxChange → MCP notification(尽力而为,拉基线兜底,§2.6)——

/** 供 EngineDeps.onInboxChange 使用:有 logging 能力就发,没有就算了。 */
export function createInboxChangeNotifier(server: McpServer): () => void {
  return () => {
    if (!server.isConnected()) return
    void server
      .sendLoggingMessage({ level: 'info', logger: 'agent-comm', data: { event: 'inbox_changed' } })
      .catch(() => {
        // 宿主不支持 logging 能力时静默忽略
      })
  }
}

// —— 12 工具注册(mcp/tools.ts 是冻结契约,这里只做 IO 变换 + 调 Engine)——

export interface McpServerOptions {
  /** 测试注入:拦截 stderr 提示(默认写 process.stderr) */
  stderr?: ((chunk: string) => void) | undefined
}

export function registerAllTools(server: McpServer, engine: Engine, opts: McpServerOptions = {}): void {
  const stderr = opts.stderr ?? ((chunk: string) => void process.stderr.write(chunk))

  // —— T1:只读 / 自身 inbox ——
  server.registerTool(
    'whoami',
    { description: toolDescriptions.whoami, inputSchema: toolInputs.whoami },
    async () => runTool(() => engine.whoami()),
  )

  server.registerTool(
    'list_channels',
    { description: toolDescriptions.list_channels, inputSchema: toolInputs.list_channels },
    async () => runTool(() => engine.listChannels()),
  )

  server.registerTool(
    'list_peers',
    { description: toolDescriptions.list_peers, inputSchema: toolInputs.list_peers },
    async (args) => runTool(() => engine.listPeers({ channel: args.channel })),
  )

  server.registerTool(
    'publish_card',
    { description: toolDescriptions.publish_card, inputSchema: toolInputs.publish_card },
    async (args) =>
      runTool(async () => {
        const actor = await resolveActor(engine, {})
        await engine.publishCard(args.card, actor)
      }),
  )

  server.registerTool(
    'ack',
    { description: toolDescriptions.ack, inputSchema: toolInputs.ack },
    async (args) => runTool(() => engine.ack({ messageId: args.messageId })),
  )

  server.registerTool(
    'send',
    { description: toolDescriptions.send, inputSchema: toolInputs.send },
    async (args) =>
      runTool(async () => {
        const actor = await resolveActor(engine, { channel: args.channel })
        return engine.send(
          {
            channel: args.channel,
            to: args.to,
            payload: args.payload,
            contentType: args.contentType,
            replyTo: args.replyTo,
            replyBy: args.replyBy,
          },
          actor,
        )
      }),
  )

  server.registerTool(
    'read_inbox',
    { description: toolDescriptions.read_inbox, inputSchema: toolInputs.read_inbox },
    async (args) =>
      runTool(async () => {
        const messages = await engine.readInbox({
          consume: args.consume,
          filter: args.filter,
          limit: args.limit,
        })
        // F4/§7.1:放行检查不阻塞 read_inbox 的返回,后台尝试 elicitation
        void tryReleaseHeld(server, engine, stderr).catch(() => {})
        return messages
      }),
  )

  // —— T2:建立/授予连接,宿主默认弹窗即人工门(D3.1)——
  server.registerTool(
    'connect',
    { description: toolDescriptions.connect, inputSchema: toolInputs.connect },
    async (args) =>
      runTool(async () => {
        const actor = await resolveActor(engine, { alias: args.alias })
        return engine.connect({ link: args.link, alias: args.alias }, actor)
      }),
  )

  server.registerTool(
    'create_invite',
    { description: toolDescriptions.create_invite, inputSchema: toolInputs.create_invite },
    async (args) =>
      runTool(async () => {
        const actor = await resolveActor(engine, { channel: args.channel })
        return engine.createInvite(
          { channel: args.channel, scope: args.scope, ttlMs: args.ttlMs, maxUses: args.maxUses },
          actor,
        )
      }),
  )

  server.registerTool(
    'create_channel',
    { description: toolDescriptions.create_channel, inputSchema: toolInputs.create_channel },
    async (args) =>
      runTool(async () => {
        const actor = await resolveActor(engine, { alias: args.alias })
        return engine.createChannel(
          {
            name: args.name,
            alias: args.alias,
            displayName: args.displayName,
            mode: args.mode,
            description: args.description,
          },
          actor,
        )
      }),
  )

  server.registerTool(
    'join_channel',
    { description: toolDescriptions.join_channel, inputSchema: toolInputs.join_channel },
    async (args) =>
      runTool(async () => {
        const actor = await resolveActor(engine, { alias: args.alias })
        return engine.joinChannel({ channel: args.channel, alias: args.alias }, actor)
      }),
  )

  server.registerTool(
    'leave_channel',
    { description: toolDescriptions.leave_channel, inputSchema: toolInputs.leave_channel },
    async (args) =>
      runTool(async () => {
        const actor = await resolveActor(engine, { channel: args.channel })
        await engine.leaveChannel({ channel: args.channel }, actor)
      }),
  )
}

/** 纯构造(无 IO):测试/嵌入场景直接拿现成 Engine 建 server。 */
export function createMcpServer(engine: Engine, opts: McpServerOptions = {}): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { capabilities: { logging: {} } })
  registerAllTools(server, engine, opts)
  return server
}

export interface RunServeOptions {
  /** 测试注入:跳过 createEngine(profile),直接用现成(通常是 fake)Engine */
  engine?: Engine | undefined
  /** 测试注入:跳过 StdioServerTransport,接测试自己的 transport(如 InMemoryTransport 的一端) */
  transport?: Transport | undefined
  /** 测试注入:拦截 stderr 提示 */
  stderr?: ((chunk: string) => void) | undefined
}

/**
 * 生产入口:main.ts 的 `agent-comm serve` 走这里,签名保持 `runServe(profile)` 与 main.ts 现状兼容
 * (main.ts 不在 W2 允许改动范围内);第二个参数纯为测试/嵌入注入,可选。
 *
 * node:sqlite 的 ExperimentalWarning 抑制(DESIGN §5 "所有进程入口统一 process.removeAllListeners
 * ('warning') 前置过滤"):由于 ES module 的静态 import 会在本函数体执行前就完成求值,若在文件顶部
 * 静态 `import { createEngine } from '../engine/engine.js'` 会导致 node:sqlite 的告警在
 * removeAllListeners 调用之前就已触发。这里改用函数体内动态 import,把"加载 engine(进而加载
 * node:sqlite)"推迟到 removeAllListeners 之后,从而在本文件的职责范围内做到真正的"前置过滤"。
 */
export async function runServe(profile: ProfilePaths, opts: RunServeOptions = {}): Promise<void> {
  process.removeAllListeners('warning')
  const stderr = opts.stderr ?? ((chunk: string) => void process.stderr.write(chunk))

  const server = new McpServer(MCP_SERVER_INFO, { capabilities: { logging: {} } })
  const engine =
    opts.engine ??
    (await (async () => {
      const { createEngine } = await import('../engine/engine.js')
      return createEngine(profile, { onInboxChange: createInboxChangeNotifier(server) })
    })())

  registerAllTools(server, engine, { stderr })

  let closed = false
  const closeOnce = async (): Promise<void> => {
    if (closed) return
    closed = true
    await engine.close()
  }
  server.server.onclose = () => {
    void closeOnce()
  }

  const transport = opts.transport ?? new StdioServerTransport()
  await server.connect(transport)
}
